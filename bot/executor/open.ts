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
 * Early binStep validation + on-chain width cap (70 bins max per position for this
 * strategy). No Zap fallback (structurally impossible for 151+ bin ranges).
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
  MAX_BINS_BY_STRATEGY,
  MAX_BINS_DEFAULT,
  MARKET_LP_SOL_PER_POSITION,
  MAX_CONCURRENT_MARKET_LP_POSITIONS,
  MAX_MARKET_LP_SOL_DEPLOYED,
  WALLET_MIN_SOL_RESERVE,
  calculateValidatedBinRange,
} from './utils'

import { getConnection, getWallet, getPriorityFee, getHeliusRpcEndpoint } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'
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
    // Smart range selection for 0 non-refundable bin array cost (per user request + UI behavior)
    // Compute full desired, show the exact "new bin array cost" the UI would display,
    // then clamp to the largest range that touches *only already-existing* bin arrays (0 new = 0 non-refundable).
    // This lets us get as close as possible to -50%/+100% without the painful 0.07 SOL hit on small positions.
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

    const desiredRequired = getBinArraysRequiredByPositionRange(
      poolPubkey,
      new BN(fullDesiredMin),
      new BN(fullDesiredMax),
      DLMM_PROGRAM_ID
    );
    let newBinArrayCount = 0;
    for (const ba of desiredRequired) {
      if (!(await connection.getAccountInfo(ba.key))) newBinArrayCount++;
    }
    const nonRefundCost = (newBinArrayCount * 0.07).toFixed(2);
    console.log(`${label} Desired range cost check: ${fullTotalBins} bins would require ${newBinArrayCount} new bin array(s) (~${nonRefundCost} SOL non-refundable)`);

    // Find the actual free bins left and right (max without new array)
    // Walk bin-by-bin from active for accuracy (small number, only on opens)
    async function findFreeBoundary(dir: 'left' | 'right', start: number, maxDist = 400) {
      let current = start;
      for (let i = 1; i <= maxDist; i++) {
        const b = dir === 'left' ? start - i : start + i;
        const arrs = getBinArraysRequiredByPositionRange(poolPubkey, new BN(b), new BN(b), DLMM_PROGRAM_ID);
        if (arrs.length === 0) break;
        const info = await connection.getAccountInfo(arrs[0].key);
        if (info) {
          current = b;
        } else {
          break;
        }
      }
      return current;
    }
    const freeLeft = await findFreeBoundary('left', activeBinId);
    const freeRight = await findFreeBoundary('right', activeBinId);

    const freeDownBins = activeBinId - freeLeft;
    const freeUpBins = freeRight - activeBinId;

    // Hard gate: if the pool's existing (free) bin arrays do not fully cover the
    // desired evil-panda range at zero cost, skip the pool entirely. Never open
    // a degraded (shrunk) position. When other traders populate the bin arrays,
    // the next scanner tick can open it cleanly.
    if (freeDownBins < fullBinsDown || freeUpBins < fullBinsUp) {
      console.log(`${label} free bin range insufficient for full evil-panda range ` +
        `(need ${fullBinsDown}↓ ${fullBinsUp}↑, free: ${freeDownBins}↓ ${freeUpBins}↑) — skipping pool`);
      return null;
    }

    // Compute a width-capped version of the *desired* % range first (this reuses
    // calculateValidatedBinRange so the claim in strategy-config.ts is true, and
    // we get its "auto-shrunk" log when the original -50/+100 would exceed 70).
    // Then apply free expansion relative to that valid base. We still cap the
    // scale so the final range never exceeds the hard on-chain limit, even if
    // free space would allow a larger position.
    const strategyMaxBins = MAX_BINS_BY_STRATEGY[strategy.id] || MAX_BINS_DEFAULT;
    const baseForFree = calculateValidatedBinRange(
      activeBinId,
      binStep,
      rangeDownPct,
      rangeUpPct,
      strategyMaxBins,
      label
    );
    const desiredDownBins = activeBinId - baseForFree.minBinId;
    const desiredUpBins = baseForFree.maxBinId - activeBinId;

    const freeScale = Math.min(
      freeDownBins / desiredDownBins,
      freeUpBins / desiredUpBins,
      1.0  // never expand beyond desired range (safety for free-bin scaling)
    );
    const maxScaleForWidth = strategyMaxBins / (desiredDownBins + desiredUpBins + 1);
    const effectiveScale = Math.min(freeScale, maxScaleForWidth);
    if (effectiveScale < freeScale) {
      console.log(`${label} free range expansion capped by on-chain position width limit (${strategyMaxBins} bins, scale limited from ${freeScale.toFixed(2)} to ${effectiveScale.toFixed(2)})`);
    }

    const actualDown = Math.floor(desiredDownBins * effectiveScale);
    const actualUp = Math.floor(desiredUpBins * effectiveScale);

    let minBinId = activeBinId - actualDown;
    let maxBinId = activeBinId + actualUp;
    const binRange = maxBinId - minBinId + 1;
    const wasShrunk = effectiveScale < 1;

    console.log(`${label} Using scaled free range (0 new bin arrays, ratio preserved): ${minBinId} → ${maxBinId} (${binRange} bins), scale=${effectiveScale.toFixed(2)}`);

    if (binRange < 2) {
      console.warn(`${label} bin range still invalid after free clamp — rejecting`);
      return null;
    }

    console.log(`${label} bin range validated: ${minBinId} → ${maxBinId} (${binRange} bins total, step=${binStep})`)

    const effectiveDownPct = -((minBinId - activeBinId) * (binStep / 10000) * 100);
    const effectiveUpPct = (maxBinId - activeBinId) * (binStep / 10000) * 100;
    console.log(`${label} effective coverage ~${effectiveDownPct.toFixed(1)}% / +${effectiveUpPct.toFixed(1)}% (desired was ${strategy.position.rangeDownPct}% / ${strategy.position.rangeUpPct}%)`);

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
      console.warn(`${label} pool has no SOL side — rejecting one-sided SOL zap-in`)
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

    const amountIn = new BN(Math.floor(solAmount * 1e9))
    const minDeltaId = minBinId - activeBinId
    const maxDeltaId = maxBinId - activeBinId
    const favorXInActiveId = solIsTokenX

    const positionKeypair = new Keypair()

    // === DIRECT ONE-SIDED SOL PRIMARY (full evil-panda range support) ===
    // Uses official DLMM SDK initializePositionAndAddLiquidityByStrategy with one-sided
    // totals (pure SOL economics, no pre-swap to the token side). The full desired
    // -50%/+100% range is only attempted when the preceding free-range gate confirmed
    // that the entire range is covered by existing bin arrays at zero cost.
    console.log(`${label} attempting direct one-sided SOL (full evil-panda range, Bid-Ask shape)`);
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
      positionKeypair
    );
    if (directResult) {
      console.log(`${label} position opened successfully via direct SDK ✔`);
      return directResult;
    }

    // If we reach here the direct path did not succeed (e.g. on-chain constraints
    // not visible in our pre-checks). No Zap fallback for evil-panda — the range
    // is structurally too wide for Zap. Return null so the scanner can try again
    // on a future tick (or the pool's free bin arrays improve).
    console.warn(`${label} direct primary did not succeed — giving up (no Zap fallback for this strategy)`);
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
  positionKeypair: Keypair
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
    const amountIn = new BN(Math.floor(solAmount * 1e9))

    console.log(`${label} entering direct one-sided SOL primary path (no pre-swap, pure SOL economics, full range)`)

    if (DRY_RUN) {
      console.log(`${label} [SAFETY] DRY_RUN true before direct position creation — aborting`)
      return null
    }

    const activeBin = await dlmmPool.getActiveBin()

    const isTokenXSol = dlmmPool.tokenX.publicKey.toBase58() === NATIVE_MINT_STR
    const isTokenYSol = dlmmPool.tokenY.publicKey.toBase58() === NATIVE_MINT_STR

    // One-sided SOL: put full amount on the SOL side, 0 on the other
    const totalX = isTokenXSol ? amountIn : new BN(0)
    const totalY = isTokenYSol ? amountIn : new BN(0)

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)

    console.log(
      `${label} using OFFICIAL direct DLMM SDK initializePositionAndAddLiquidityByStrategy ` +
      `(one-sided on SOL primary, range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
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

// (swapSolToTokenViaJupiter removed - no longer needed after switching fallback to pure SOL one-sided)
