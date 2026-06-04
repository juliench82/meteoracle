/**
 * bot/executor/open.ts
 *
 * Position opening for Meteora DLMM.
 * Primary path: Meteora Zap SDK (with retries + singleSided flag for pure SOL deposit, full range).
 * Direct SDK fallback (one-sided SOL amounts + full range via initializePositionAndAddLiquidityByStrategy)
 * is used only when Zap fails. Matches UI behavior for % range + single-sided.
 * Early real-binStep validation + proportional shrinking protects against InvalidPositionWidth.
 *
 * Note: We no longer force the manual path for all Token-2022. If the Meteora Zap UI can zap-in a pool,
 * the bot's Zap path should be able to as well (cleaner atomic flow, no separate pre-swap in bot code).
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
import type { ZapInDlmmResponse } from '@meteora-ag/zap-sdk'
import { DlmmSingleSided } from '@meteora-ag/zap-sdk'


import {
  getDLMM,
  getStrategyType,
  getZap,
  strategyTypeForDistribution,
  findStrategyForPosition,
  getTotalDeployedSolForCap,
  getTokenProgramId,
  getDecimalAdjustedPrice,
  NATIVE_MINT_STR,
  METEORA_RENT_RESERVE_SOL,
  DLMM_ZAP_SWAP_SLIPPAGE_BPS,
  DLMM_ZAP_MAX_ACTIVE_BIN_SLIPPAGE,
  DLMM_ZAP_MAX_ACCOUNTS,
  DLMM_ZAP_MAX_TRANSFER_EXTEND_PERCENTAGE,
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
    // SECTION: Early Bin Range Validation (prevents InvalidPositionWidth)
    // =============================================================================
    const maxBins = MAX_BINS_BY_STRATEGY[strategy.id] ?? MAX_BINS_DEFAULT;

    const { minBinId, maxBinId, binRange, wasShrunk } = calculateValidatedBinRange(
      activeBinId,
      binStep,
      strategy.position.rangeDownPct,
      strategy.position.rangeUpPct,
      maxBins,
      label
    );

    if (binRange < 2 || binRange > maxBins) {
      console.warn(`${label} bin range still invalid after shrinking — rejecting early`, {
        binRange,
        maxBins,
        binStep,
        strategy: strategy.id,
      });
      logWarn('legacy_bot_log', {
        level: 'warn',
        event: 'open_position_skipped_invalid_bin_range',
        payload: { symbol: metrics.symbol, strategy: strategy.id, binRange, maxBins, binStep },
      });
      return null;
    }

    console.log(`${label} bin range validated: ${minBinId} → ${maxBinId} (${binRange} bins, step=${binStep})`)
    // =============================================================================
    // END: Early Bin Range Validation
    // =============================================================================

    // Token-2022 / pump.fun / DBC graduates are no longer forced into the manual path.
    // We let the Zap path run for them too. Many (like TACO-SOL) can be zapped successfully
    // via the Meteora app, so the bot should use the same clean Zap flow (atomic swap + LP).
    // The direct-SDK fallback (pre-swap + initializePositionAndAddLiquidityByStrategy) is available
    // if the Zap path cannot handle a particular Token-2022 pool's hooks.
    if (isToken2022) {
      console.log(`${label} Token-2022 / pump.fun / DBC 0.2.0 graduate — attempting Zap path first (direct SDK fallback only if Zap fails)`);
    }

    // ATA pre-creation for the token side(s) before attempting Zap (uses getTokenProgramId per mint so Token-2022 sides get the correct program).
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

    // === ZAP-FIRST ARCHITECTURE (with one direct SDK fallback) ===
    // Primary path: Meteora Zap SDK + singleSided flag — clean atomic SOL-only zaps with full % range (matches Meteora UI).
    console.log(`${label} starting Zap path (singleSided=${solIsTokenX ? 'X' : 'Y'})`);
    const { openSig, lastZapErr } = await tryZapInWithRetries({
      label,
      dlmmPool,
      poolPubkey,
      minBinId,
      maxBinId,
      solAmount,
      amountIn: new BN(Math.floor(solAmount * 1e9)),
      solIsTokenX,
      strategyType,
      priorityFee,
      positionKeypair,
      wallet,
      connection,
      DRY_RUN,
    });

    // Reached after Zap attempts (either success or both failed).
    // Safety net when Zap fails. Fallback uses one-sided SOL amounts (no pre-swap) +
    // full range via the official direct DLMM SDK initializePositionAndAddLiquidityByStrategy.
    if (!openSig && lastZapErr) {
      console.warn(`${label} Zap path exhausted after 2 attempts — lastZapErr=${lastZapErr?.message || lastZapErr}; trying direct SDK fallback (one-sided SOL)`)
      try {
        // Fallback using the official DLMM SDK method recommended in Meteora docs (after Zap fails).
        // Pure one-sided SOL for SOL economics, no pre-swap.
        return await openPositionDirectSdkFallback(
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
          await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()]),
          // local-state only
          DRY_RUN,
          new Keypair()
        )
      } catch (manualErr) {
        console.error(`${label} manual fallback also failed — giving up on ${metrics.symbol}`)
        throw manualErr
      }
    }

    if (openSig) {
      console.log(`${label} position opened successfully via Zap path`)
    }

    const result = await finalizeOpenPosition({
      label,
      metrics,
      strategy,
      openSig,
      entryPriceSol,
      solAmount,
      positionKeypair,
      dlmmPool,
      DRY_RUN,
      wallet,
    });

    return result;

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

/**
 * Extracted Zap retry logic for readability.
 * Handles up to 2 attempts with the Meteora Zap SDK, including per-attempt cleanup.
 */
async function tryZapInWithRetries(params: {
  label: string;
  dlmmPool: any;
  poolPubkey: PublicKey;
  minBinId: number;
  maxBinId: number;
  solAmount: number;
  amountIn: BN;
  solIsTokenX: boolean;
  strategyType: any;
  priorityFee: number;
  positionKeypair: Keypair;
  wallet: Keypair;
  connection: Connection;
  DRY_RUN: boolean;
}): Promise<{ openSig: string; lastZapErr: any }> {
  const {
    label, dlmmPool, poolPubkey, minBinId, maxBinId, solAmount, amountIn,
    solIsTokenX, strategyType, priorityFee, positionKeypair, wallet, connection, DRY_RUN,
  } = params;

  const attemptLabelBase = label;
  const favorXInActiveId = solIsTokenX;
  const singleSided = solIsTokenX ? DlmmSingleSided.X : DlmmSingleSided.Y;
  console.log(`${attemptLabelBase} singleSided=${singleSided} (SOL side=${solIsTokenX ? 'X' : 'Y'}), using FULL range deltas for position (UI-style)`);

  const sendZapTx = async (
    tx: Transaction | undefined,
    signers: import('@solana/web3.js').Signer[],
    stage: string,
    attemptLabel: string,
  ): Promise<string | null> => {
    if (!tx || tx.instructions.length === 0) return null;
    const sig = await sendLegacyTx(applyPriorityFee(tx, priorityFee), signers, attemptLabel);
    console.log(`${attemptLabel} zap-in ${stage} confirmed ✔ sig: ${sig}`);
    return sig;
  };

  let openSig = '';
  let lastZapErr: any = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptLabel = `${attemptLabelBase} (attempt ${attempt}/2)`;
    let cleanupSentThisAttempt = false;

    try {
      console.log(`${attemptLabel} building fresh zap quote...`);

      const activeBin = await dlmmPool.getActiveBin();
      const currentActiveBinId = activeBin.binId;
      const currentMinDeltaId = minBinId - currentActiveBinId;
      const currentMaxDeltaId = maxBinId - currentActiveBinId;
      // Note: we pass the full min/max deltas (the evil-panda -50%/+100% range)
      // even for singleSided. The singleSided flag tells the Zap/estimate to do
      // pure one-sided deposit (swapAmount=0). This matches what the Meteora UI
      // does when you set full % range + single-sided deposit.

      const { estimateDlmmDirectSwap } = await import('@meteora-ag/zap-sdk');
      const directSwapEstimate = await estimateDlmmDirectSwap({
        amountIn,
        inputTokenMint: NATIVE_MINT,
        lbPair: poolPubkey,
        connection,
        swapSlippageBps: DLMM_ZAP_SWAP_SLIPPAGE_BPS,
        minDeltaId: currentMinDeltaId,
        maxDeltaId: currentMaxDeltaId,
        strategy: strategyType,
        singleSided,
      });

      console.log(
        `${attemptLabel} DLMM zap-in estimate: input=${amountIn.toString()} lamports ` +
        `solSide=${solIsTokenX ? 'X' : 'Y'} singleSided=${singleSided} ` +
        `rangeDeltas: min=${currentMinDeltaId} max=${currentMaxDeltaId} (full evil-panda range) ` +
        `swapAmount=${directSwapEstimate.result.swapAmount.toString()} ` +
        `postX=${directSwapEstimate.result.postSwapX.toString()} postY=${directSwapEstimate.result.postSwapY.toString()}`,
      );

      const zap = await getZap();
      const zapParams = await zap.getZapInDlmmDirectParams({
        user: wallet.publicKey,
        lbPair: poolPubkey,
        inputTokenMint: NATIVE_MINT,
        amountIn,
        maxActiveBinSlippage: DLMM_ZAP_MAX_ACTIVE_BIN_SLIPPAGE,
        minDeltaId: currentMinDeltaId,
        maxDeltaId: currentMaxDeltaId,
        strategy: strategyType,
        favorXInActiveId,
        maxAccounts: DLMM_ZAP_MAX_ACCOUNTS,
        swapSlippageBps: DLMM_ZAP_SWAP_SLIPPAGE_BPS,
        maxTransferAmountExtendPercentage: DLMM_ZAP_MAX_TRANSFER_EXTEND_PERCENTAGE,
        directSwapEstimate: directSwapEstimate.result,
        singleSided,
      });

      const zapResponse: ZapInDlmmResponse = await zap.buildZapInDlmmTransaction({
        ...zapParams,
        position: positionKeypair.publicKey,
      });

      const sendCleanupThisAttemptFn = async (stage: string): Promise<void> => {
        if (cleanupSentThisAttempt) return;
        cleanupSentThisAttempt = true;
        try {
          await sendZapTx(zapResponse.cleanUpTransaction, [wallet], stage, attemptLabel);
        } catch (cleanupErr) {
          console.warn(`${attemptLabel} zap-in cleanup failed after ${stage}:`, cleanupErr);
        }
      };

      await sendZapTx(zapResponse.setupTransaction, [wallet], 'setup', attemptLabel);
      for (let i = 0; i < zapResponse.swapTransactions.length; i++) {
        await sendZapTx(zapResponse.swapTransactions[i], [wallet], `swap ${i + 1}/${zapResponse.swapTransactions.length}`, attemptLabel);
      }
      await sendZapTx(zapResponse.ledgerTransaction, [wallet], 'ledger', attemptLabel);
      openSig = await sendZapTx(zapResponse.zapInTransaction, [wallet, positionKeypair], 'position', attemptLabel) ?? '';
      await sendZapTx(zapResponse.cleanUpTransaction, [wallet], 'cleanup', attemptLabel);

      console.log(`${attemptLabel} position opened successfully`);
      break;

    } catch (zapErr) {
      lastZapErr = zapErr;
      console.warn(`${label} attempt ${attempt}/2 failed:`, zapErr);

      if (attempt === 2) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  return { openSig, lastZapErr };
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
 * Fallback open path using official direct DLMM SDK (after Zap primary fails).
 * Pure one-sided SOL (no pre-swap) + dlmmPool.initializePositionAndAddLiquidityByStrategy
 * (the method recommended in Meteora's latest DLMM SDK docs). Supports Token-2022 via the SDK.
 *
 * Reached only when the Zap path (preferred, atomic, no bot-level pre-swap) fails.
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
  const label = `${attemptLabel}[direct-fallback]`

  console.log(`${label} [DRY-RUN GUARD] DRY_RUN param received: ${DRY_RUN}`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return null
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const amountIn = new BN(Math.floor(solAmount * 1e9))

    console.log(`${label} entering direct one-sided SOL fallback (no pre-swap, pure SOL economics)`)

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
      `(one-sided on SOL, range ${minBinId} → ${maxBinId}, strategyType=${strategyType})`
    )
    console.log(`${label} totals for SDK call: totalX=${totalX.toString()} totalY=${totalY.toString()}`)

    // Step 3: Add ATA pre-creation before the direct call if the SDK doesn't handle it
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

    console.log(`${label} position opened successfully via direct SDK fallback path ✔`)
    return positionId

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    logError('open_position_direct_fallback_failed', {
      symbol: metrics.symbol,
      strategy: strategy.id,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    return null
  }
}

// (swapSolToTokenViaJupiter removed - no longer needed after switching fallback to pure SOL one-sided)
