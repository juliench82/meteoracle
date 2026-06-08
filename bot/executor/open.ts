/**
 * bot/executor/open.ts
 *
 * Position opening for Meteora DLMM (evil-panda: Bid-Ask, one-sided SOL).
 * Uses the official DLMM SDK initializePositionAndAddLiquidityByStrategy (one-sided
 * SOL, full desired -50%/+100% range on binStep=100).
 *
 * Hard free-range gate: the pool's existing bin arrays must fully cover the desired
 * range at zero cost (no new bin arrays = no 0.07 SOL non-refundable hit). If not,
 * the pool is skipped cleanly. When other LPs/swaps populate the arrays, a future
 * tick can open it.
 *
 * No artificial width cap. Uses exact rounded bin range from the desired % (Meteora
 * will use discrete boundaries; effective coverage is logged).
 */

import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token'
import BN from 'bn.js'
import { logInfo, logError, logWarn } from '@/lib/log'
import { getOpenLpPositions } from '@/lib/local-state'
import type { StrategyType } from '@meteora-ag/dlmm'

import {
  getDLMM,
  getStrategyType,
  strategyTypeForDistribution,
  findStrategyForPosition,
  getTotalDeployedSolForCap,
  getTokenProgramId,
  getDecimalAdjustedPrice,
  NATIVE_MINT_STR,
  METEORA_RENT_RESERVE_SOL,
  MARKET_LP_SOL_PER_POSITION,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MAX_MARKET_LP_SOL_DEPLOYED,
  WALLET_MIN_SOL_RESERVE,
} from './utils'

import { getConnection, getWallet, getPriorityFee, getHeliusRpcEndpoint } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'
import { swapSolToToken } from '@/lib/swap'
import {
  OPEN_LP_STATUSES,
  assertCanOpenLpPosition,
  getOpenLpLimitState,
  type OpenLpLimitState,
} from '@/lib/position-limits'
import { STRATEGIES } from '@/strategies'


import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
  addPriorityFeeAndPreserveComputeLimit,
} from '@/lib/solana-tx'

import {
  persistPosition,
  sendOpenAlert,
  findExistingActivePosition,
} from './persistence'

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

// =============================================================================
// SECTION: Main openPosition flow
// =============================================================================








export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
): Promise<string | null> {
  const label = `[executor][${strategy.id}][${metrics.symbol}]`
  console.log(`${label} opening position`)

  const botState = await getBotState()
  const DRY_RUN = ENV_DRY_RUN_FORCED || botState.dry_run

  // Very loud early visibility for dry-run state (helps debug VPS env loading issues)
  console.log(
    `${label} DRY_RUN effective value: ${DRY_RUN} ` +
    `(ENV_FORCED=${ENV_DRY_RUN_FORCED}, botState.dry_run=${botState.dry_run})`
  )


  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)

    // Idempotency guard: prevent duplicate inserts into lp_positions during long dry-run observation.
    // Dry-run rows live only in local state, so the scanner guards
    // can be bypassed on later ticks → we must defend here too.
    const existing = await findExistingActivePosition(metrics.address)
    if (existing) {
      console.log(`${label} DRY RUN — ${metrics.symbol} already has active simulation row (id=${existing.id}). Skipping duplicate persist to avoid lp_positions_mint_open_unique violation.`)
      return existing.id
    }

    const envCap = MARKET_LP_SOL_PER_POSITION
    const dryRunSolAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap
    console.log(`${label} DRY RUN — creating new simulation row for ${metrics.symbol} (first time this tick/scan)`)
    const positionId = await persistPosition(metrics, strategy, 'dry-run-sig', metrics.priceUsd ?? 0, 0, dryRunSolAmount, undefined, 0, DRY_RUN)
    await sendOpenAlert(metrics, strategy, positionId, dryRunSolAmount, 0)
    return positionId
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const envCap = MARKET_LP_SOL_PER_POSITION
    const solAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap

    const eligibility = await validateOpenEligibility(label, metrics, strategy, solAmount, connection, wallet);
    if (!eligibility.ok) {
      return null;
    }

    const { limitState, poolPubkey } = eligibility;

    console.log(
      `${label} market LP cap ok (${limitState.effectiveOpenCount || 0}/${MAX_CONCURRENT_MARKET_LP_POSITIONS})`,
    );

    const DLMM = await getDLMM()
    const dlmmPool = await DLMM.create(connection, poolPubkey)
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId

    const entryPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin)
    console.log(`${label} entry price: ${entryPriceSol.toFixed(9)} SOL/token (bin ${activeBinId})`)

    const binStep = dlmmPool.lbPair.binStep
    const mintX = dlmmPool.tokenX.publicKey
    const mintY = dlmmPool.tokenY.publicKey
    const solIsTokenX = mintX.toBase58() === NATIVE_MINT_STR
    const solIsTokenY = mintY.toBase58() === NATIVE_MINT_STR

    const outputMint = solIsTokenX ? mintY : mintX
    const outputTokenProgram = await getTokenProgramId(outputMint)
    const isToken2022 = outputTokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()

    console.log(`${label} Token program resolved for output mint ${outputMint.toBase58().slice(0, 8)} → ${isToken2022 ? 'Token-2022' : 'Legacy Token'}`)

    // =============================================================================
    // Exact -50% / +100% range calculation + bin array existence gate (zero cost only)
    // No artificial width cap. Use the full desired range only if all required
    // bin arrays already exist on-chain (0 new arrays = 0 rent cost).
    // Use runtime rent exemption size for accurate cost reporting.
    // =============================================================================
    const rangeDownPct = strategy.position.rangeDownPct;
    const rangeUpPct = strategy.position.rangeUpPct;
    const fullBinsDown = Math.abs(Math.round((rangeDownPct / 100) / (binStep / 10000)));
    const fullBinsUp = Math.round((rangeUpPct / 100) / (binStep / 10000));
    const fullDesiredMin = activeBinId - fullBinsDown;
    const fullDesiredMax = activeBinId + fullBinsUp;
    const fullTotalBins = fullDesiredMax - fullDesiredMin + 1;

    const { getBinArraysRequiredByPositionRange } = await import('@meteora-ag/dlmm');
    const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

    const requiredBinArrays = getBinArraysRequiredByPositionRange(
      poolPubkey,
      new BN(fullDesiredMin),
      new BN(fullDesiredMax),
      DLMM_PROGRAM_ID
    );
    let newBinArrayCount = 0;
    for (const ba of requiredBinArrays) {
      if (!(await connection.getAccountInfo(ba.key))) newBinArrayCount++;
    }

    const rentPerArray = await connection.getMinimumBalanceForRentExemption(3472) / 1e9;
    const nonRefundCost = (newBinArrayCount * rentPerArray).toFixed(2);
    console.log(`${label} Desired range cost check: ${fullTotalBins} bins would require ${newBinArrayCount} new bin array(s) (~${nonRefundCost} SOL non-refundable)`);

    if (newBinArrayCount > 0) {
      console.log(`${label} free bin range insufficient for full evil-panda range — skipping pool (would require new bin arrays)`);
      return null;
    }

    const minBinId = fullDesiredMin;
    const maxBinId = fullDesiredMax;
    const binRange = fullTotalBins;

    console.log(`${label} bin range validated: ${minBinId} → ${maxBinId} (${binRange} bins total, step=${binStep})`);

    const effectiveDownPct = fullBinsDown * (binStep / 10000) * 100;
    const effectiveUpPct = fullBinsUp * (binStep / 10000) * 100;
    console.log(`${label} effective coverage ~${effectiveDownPct.toFixed(1)}% / +${effectiveUpPct.toFixed(1)}% (desired was ${rangeDownPct}% / ${rangeUpPct}%)`);

    // ATA pre-creation for the token side(s) (uses getTokenProgramId per mint so Token-2022 sides get the correct program).
    // Done before the direct SDK path.
    const ataIxs: TransactionInstruction[] = []
    for (const [lbl, mint] of [['X', mintX], ['Y', mintY]] as [string, PublicKey][]) {
      if (mint.toBase58() === NATIVE_MINT_STR) {
        console.log(`${label} token ${lbl} is native SOL — skipping ATA`)
        continue
      }
      const tokenProgramId = await getTokenProgramId(mint)
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID)
      if (!(await connection.getAccountInfo(ata))) {
        console.log(`${label} creating ATA for token ${lbl} (${mint.toBase58().slice(0, 8)}…)`)
        ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, ata, wallet.publicKey, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
        ))
      }
    }
    if (ataIxs.length > 0) {
      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ...ataIxs
      )
      const ataSig = await sendLegacyTx(ataTx, [wallet], label)
      console.log(`${label} ATA(s) created ✔ sig: ${ataSig}`)
    }

    if (!solIsTokenX && !solIsTokenY) {
      console.warn(`${label} pool has no SOL side — rejecting one-sided SOL`)
      logWarn('legacy_bot_log', {
        level: 'warn',
        event: 'open_position_skipped_non_sol_pair',
        payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress },
      })
      return null
    }

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    const priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

    const totalSolLamports = BigInt(Math.floor(solAmount * 1e9))
    const binsTotal = fullBinsDown + fullBinsUp + 1  // +1 for the active bin
    const solToSwapLamports = totalSolLamports * BigInt(fullBinsDown) / BigInt(binsTotal)
    const remainingSolLamports = totalSolLamports - solToSwapLamports

    console.log(`${label} one-sided split for Bid-Ask: swap ${solToSwapLamports} lamports SOL for token side, keep ${remainingSolLamports} as SOL side`)

    // Pre-quote for validation (do not send yet)
    try {
      const params = new URLSearchParams({
        inputMint: NATIVE_MINT_STR,
        outputMint: outputMint.toBase58(),
        amount: solToSwapLamports.toString(),
        slippageBps: '1000',
        onlyDirectRoutes: 'false',
      })
      const quoteUrl = `https://api.jup.ag/swap/v1/quote?${params.toString()}`
      const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(7000) })
      if (!quoteRes.ok) throw new Error(`quote http ${quoteRes.status}`)
      const quote = await quoteRes.json()
      if (quote?.error || quote?.errorCode) throw new Error(quote.error || quote.errorCode || 'quote error')
      const expectedOut = BigInt(quote.outAmount ?? quote.out_amount ?? '0')
      console.log(`${label} pre-quote OK: ${solToSwapLamports} SOL → ~${expectedOut} ${outputMint.toBase58().slice(0,8)} token`)
    } catch (e) {
      console.warn(`${label} pre-quote SOL→token failed — skipping pool: ${e instanceof Error ? e.message : e}`)
      return null
    }

    // Execute the swap
    const swapRes = await swapSolToToken(outputMint.toBase58(), solToSwapLamports, label)
    if (!swapRes) {
      console.error(`${label} swap SOL to token failed`)
      return null
    }
    const actualTokenLamports = swapRes.tokenAmount
    console.log(`${label} swap done: received ${actualTokenLamports} token lamports`)

    const positionKeypair = new Keypair()

    // === DIRECT (after explicit pre-swap for the token side) ===
    console.log(`${label} attempting direct one-sided SOL (full evil-panda range, Bid-Ask shape) after Jupiter swap`);
    const directResult = await openPositionDirectSdkFallback(
      metrics,
      strategy,
      dlmmPool,
      poolPubkey,
      outputMint,
      outputTokenProgram,
      solAmount,
      minBinId,
      maxBinId,
      solIsTokenX,
      label,
      priorityFee,
      DRY_RUN,
      positionKeypair,
      remainingSolLamports,
      actualTokenLamports
    );
    if (directResult) {
      console.log(`${label} position opened successfully via direct SDK ✔`);
      return directResult;
    }

    console.warn(`${label} direct primary did not succeed — giving up`);
    return null;

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    logError('open_position_failed', {
      symbol: metrics.symbol,
      strategy: strategy.id,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    return null
  }
}

async function finalizeOpenPosition(params: {
  label: string;
  metrics: TokenMetrics;
  strategy: Strategy;
  openSig: string;
  entryPriceSol: number;
  solAmount: number;
  positionKeypair: Keypair;
  dlmmPool: any;
  DRY_RUN: boolean;
  wallet: Keypair;
}): Promise<string | null> {
  const { label, metrics, strategy, openSig, entryPriceSol, solAmount, positionKeypair, dlmmPool, DRY_RUN, wallet } = params;

  let tokenAmountDeposited = 0;
  try {
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const userPos = userPositions.find(
      (p: any) => p.publicKey.toBase58() === positionKeypair.publicKey.toBase58()
    );
    if (userPos) {
      const rawAmount = userPos.positionData.totalXAmount;
      tokenAmountDeposited = typeof rawAmount === 'object'
        ? (rawAmount as BN).toNumber() / 1e6
        : Number(rawAmount) / 1e6;
      console.log(`${label} token amount deposited: ${tokenAmountDeposited.toFixed(4)}`);
    }
  } catch (err) {
    console.warn(`${label} could not fetch token amount:`, err);
  }

  console.log(`${label} position opened ✔`);
  const positionId = await persistPosition(
    metrics, strategy, openSig,
    metrics.priceUsd ?? 0, entryPriceSol, solAmount,
    positionKeypair.publicKey.toBase58(), tokenAmountDeposited, DRY_RUN
  );
  await sendOpenAlert(metrics, strategy, positionId, solAmount, entryPriceSol);

  return positionId;
}

async function validateOpenEligibility(
  label: string,
  metrics: TokenMetrics,
  strategy: Strategy,
  solAmount: number,
  connection: Connection,
  wallet: Keypair
): Promise<
  | { ok: false }
  | {
      ok: true;
      limitState: any;
      poolPubkey: PublicKey;
    }
> {
  let limitState: any = await getOpenLpLimitState();

  const effectiveOpenCountForCap = limitState.effectiveOpenCount || 0;

  console.log(
    `${label} market LP cap ok (${effectiveOpenCountForCap}/${MAX_CONCURRENT_MARKET_LP_POSITIONS})`,
  );

  const maxTotalDeployed = MAX_MARKET_LP_SOL_DEPLOYED;
  const { totalDeployed, source: exposureSource } = await getTotalDeployedSolForCap(limitState);

  if (totalDeployed + solAmount > maxTotalDeployed) {
    console.warn(`${label} global exposure cap hit — ${totalDeployed.toFixed(3)} SOL deployed (${exposureSource})`);
    logWarn('open_position_skipped_exposure_cap', {
      symbol: metrics.symbol,
      totalDeployed,
      solAmount,
      maxTotalDeployed,
      source: exposureSource,
    });
    return { ok: false };
  }

  const balanceLamports = await connection.getBalance(wallet.publicKey);
  const balanceSol = balanceLamports / 1e9;
  console.log(`${label} wallet balance: ${balanceSol.toFixed(4)} SOL`);

  const requiredSol = solAmount + METEORA_RENT_RESERVE_SOL + WALLET_MIN_SOL_RESERVE;

  if (balanceSol < requiredSol) {
    console.warn(`${label} insufficient balance — need ${requiredSol.toFixed(3)} SOL, have ${balanceSol.toFixed(4)}`);
    logWarn('legacy_bot_log', {
      level: 'warn',
      event: 'open_position_skipped_insufficient_balance',
      payload: {
        symbol: metrics.symbol,
        balanceSol,
        requiredSol,
        solAmount,
        meteoraRentReserveSol: METEORA_RENT_RESERVE_SOL,
        walletMinSolReserve: WALLET_MIN_SOL_RESERVE,
      },
    });
    return { ok: false };
  }

  let poolPubkey: PublicKey;
  try {
    poolPubkey = new PublicKey(metrics.poolAddress || '');
  } catch (e: any) {
    console.error(`${label} invalid poolAddress "${metrics.poolAddress}": ${e?.message || e}`);
    logWarn('legacy_bot_log', {
      level: 'error',
      event: 'open_position_skipped_bad_pool_address',
      payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress, error: e?.message || String(e) },
    });
    return { ok: false };
  }

  // Validate that this is a real on-chain DLMM pair
  try {
    const poolAccount = await connection.getAccountInfo(poolPubkey);
    const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
    if (!poolAccount || poolAccount.owner.toBase58() !== DLMM_PROGRAM_ID) {
      console.warn(`${label} pool ${metrics.poolAddress} not a valid DLMM lb pair (owner=${poolAccount?.owner.toBase58() ?? 'missing'}) — skipping`);
      logWarn('legacy_bot_log', {
        level: 'warn',
        event: 'open_position_skipped_non_dlmm_pool',
        payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress },
      });
      return { ok: false };
    }
  } catch (e: any) {
    console.warn(`${label} pool account lookup failed for ${metrics.poolAddress}: ${e?.message || e} — skipping open`);
    return { ok: false };
  }

  return { ok: true, limitState, poolPubkey };
}

/**
 * Direct one-sided SOL primary path (Zap is fallback).
 * Pure one-sided SOL (no pre-swap) + dlmmPool.initializePositionAndAddLiquidityByStrategy
 * (the method recommended in Meteora's latest DLMM SDK docs). Supports Token-2022 via the SDK.
 *
 * Primary for evil-panda to support full desired ranges (e.g. 149+ bins on binStep=100).
 */
async function openPositionDirectSdkFallback(
  metrics: TokenMetrics,
  strategy: Strategy,
  dlmmPool: any,
  poolPubkey: PublicKey,
  outputMint: PublicKey,
  outputTokenProgram: PublicKey,
  solAmount: number,
  minBinId: number,
  maxBinId: number,
  solIsTokenX: boolean,
  attemptLabel: string,
  priorityFee: number,
  DRY_RUN: boolean,
  positionKeypair: Keypair,
  remainingSolLamports: bigint = 0n,
  actualTokenLamports: bigint = 0n
): Promise<string | null> {
  const label = `${attemptLabel}[direct-primary]`

  console.log(`${label} [DRY-RUN GUARD] DRY_RUN param received: ${DRY_RUN}`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return null
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    if (DRY_RUN) {
      console.log(`${label} [SAFETY] DRY_RUN true before direct position creation — aborting`)
      return null
    }

    const activeBin = await dlmmPool.getActiveBin()

    const isTokenXSol = dlmmPool.tokenX.publicKey.toBase58() === NATIVE_MINT_STR
    const isTokenYSol = dlmmPool.tokenY.publicKey.toBase58() === NATIVE_MINT_STR

    // After explicit Jupiter swap for the token side (Bid-Ask one-sided distribution)
    const totalX = isTokenXSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())
    const totalY = isTokenYSol ? new BN(remainingSolLamports.toString()) : new BN(actualTokenLamports.toString())

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    console.log(
      `${label} using OFFICIAL direct DLMM SDK initializePositionAndAddLiquidityByStrategy ` +
      `(after Jupiter swap for token side, range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
    )
    console.log(`${label} totals for SDK call: totalX=${totalX.toString()} totalY=${totalY.toString()}`)

    // ATA pre-creation before the direct call (primary path) if the SDK doesn't handle it
    const ataIxs: TransactionInstruction[] = []
    for (const [lbl, mint, program] of [
      ['X', dlmmPool.tokenX.publicKey, isTokenXSol ? TOKEN_PROGRAM_ID : outputTokenProgram],
      ['Y', dlmmPool.tokenY.publicKey, isTokenYSol ? TOKEN_PROGRAM_ID : outputTokenProgram],
    ] as const) {
      if (mint.equals(NATIVE_MINT)) {
        console.log(`${label} token ${lbl} is native SOL — skipping ATA`)
        continue
      }
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, program, ASSOCIATED_TOKEN_PROGRAM_ID)
      if (!(await connection.getAccountInfo(ata))) {
        console.log(`${label} creating ATA for token ${lbl} (${mint.toBase58().slice(0, 8)}…)`)
        ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, ata, wallet.publicKey, mint, program, ASSOCIATED_TOKEN_PROGRAM_ID
        ))
      }
    }
    if (ataIxs.length > 0) {
      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ...ataIxs
      )
      const ataSig = await sendLegacyTx(ataTx, [wallet], label)
      console.log(`${label} ATA(s) created ✔ sig: ${ataSig}`)
    }

    const createPositionTxOrTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalX,
      totalYAmount: totalY,
      strategy: {
        minBinId,
        maxBinId,
        strategyType,
      },
    })

    const txsToSend = Array.isArray(createPositionTxOrTxs) ? createPositionTxOrTxs : [createPositionTxOrTxs]
    let liqSig = ''
    for (const tx of txsToSend) {
      const preparedTx = applyPriorityFee(tx, priorityFee)
      const sig = await sendLegacyTx(preparedTx, [wallet, positionKeypair], `${label} direct-sdk`)
      console.log(`${label} ✓ direct SDK position created & confirmed. Sig: ${sig}`)
      liqSig = sig
    }

    // Fetch position data for persistence (best effort)
    let tokenAmountDeposited = 0
    try {
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
      const userPos = userPositions.find(
        (p: any) => p.publicKey.toBase58() === positionKeypair.publicKey.toBase58()
      )
      if (userPos?.positionData) {
        const pd = userPos.positionData
        const rawAmount = isTokenXSol ? pd.totalYAmount : pd.totalXAmount
        tokenAmountDeposited = typeof rawAmount === 'object'
          ? (rawAmount as BN).toNumber() / 1e6
          : Number(rawAmount) / 1e6
      }
    } catch (inspectErr) {
      console.warn(`${label} Could not fetch final position data for logging:`, inspectErr)
    }

    const openSig = liqSig

    const positionId = await persistPosition(
      metrics,
      strategy,
      openSig,
      metrics.priceUsd ?? 0,
      getDecimalAdjustedPrice(dlmmPool, activeBin),
      solAmount,
      positionKeypair.publicKey.toBase58(),
      tokenAmountDeposited,
      DRY_RUN
    )

    await sendOpenAlert(metrics, strategy, positionId, solAmount, getDecimalAdjustedPrice(dlmmPool, activeBin))

    console.log(`${label} position opened successfully via direct SDK primary path ✔`)
    return positionId

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    logError('open_position_direct_primary_failed', {
      symbol: metrics.symbol,
      strategy: strategy.id,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    return null
  }
}

// swapSolToToken is now used for the explicit pre-swap in the one-sided Bid-Ask open flow.
