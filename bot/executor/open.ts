/**
 * bot/executor/open.ts
 *
 * Position opening for Meteora DLMM.
 * Primary path: Zap SDK (with retries). One manual fallback (Jupiter + raw DLMM) for Token-2022.
 * Early real-binStep validation + proportional shrinking protects against InvalidPositionWidth.
 */

import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
  Connection,
  VersionedTransaction,
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
import type { StrategyType } from '@meteora-ag/dlmm'
import type { ZapInDlmmResponse } from '@meteora-ag/zap-sdk'


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
  ADD_LIQUIDITY_FALLBACK_CU,
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
} from './utils'

import { getConnection, getWallet, getPriorityFee, getHeliusRpcEndpoint } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
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
} from './persistence'

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'








export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
  options: { rebalanceFromPositionId?: string } = {},
): Promise<string | null> {
  const label = `[executor][${strategy.id}][${metrics.symbol}]`
  console.log(`${label} opening position`)

  const botState = await getBotState()
  const DRY_RUN = ENV_DRY_RUN_FORCED || botState.dry_run
  const supabase = createServerClient()

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    const envCap = MARKET_LP_SOL_PER_POSITION
    const dryRunSolAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap
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

    const limitState = options.rebalanceFromPositionId
      ? await getOpenLpLimitState('market')
      : await assertCanOpenLpPosition(MAX_CONCURRENT_MARKET_LP_POSITIONS, label, 'market')

    const effectiveOpenCountForCap = options.rebalanceFromPositionId
      ? Math.max(0, limitState.effectiveOpenCount - 1)
      : limitState.effectiveOpenCount

    if (options.rebalanceFromPositionId) {
      if (effectiveOpenCountForCap >= MAX_CONCURRENT_MARKET_LP_POSITIONS) {
        throw new Error(
          `${label} max LP positions reached after rebalance adjustment ` +
          `(${effectiveOpenCountForCap}/${MAX_CONCURRENT_MARKET_LP_POSITIONS}; source=${limitState.countSource}, ` +
          `live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount})`,
        )
      }
    }

    console.log(
      `${label} market LP cap ok (${effectiveOpenCountForCap}/${MAX_CONCURRENT_MARKET_LP_POSITIONS}; ` +
      `source=${limitState.countSource}, live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount})`,
    )

    const maxTotalDeployed = MAX_MARKET_LP_SOL_DEPLOYED
    const { totalDeployed, source: exposureSource } = await getTotalDeployedSolForCap(supabase, limitState)

    if (totalDeployed + solAmount > maxTotalDeployed) {
      console.warn(`${label} global exposure cap hit — ${totalDeployed.toFixed(3)} SOL deployed (${exposureSource})`)
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_exposure_cap',
        payload: { symbol: metrics.symbol, totalDeployed, solAmount, maxTotalDeployed, source: exposureSource },
      })
      return null
    }

    const balanceLamports = await connection.getBalance(wallet.publicKey)
    const balanceSol = balanceLamports / 1e9
    console.log(`${label} wallet balance: ${balanceSol.toFixed(4)} SOL`)

    const requiredSol = solAmount + METEORA_RENT_RESERVE_SOL + WALLET_MIN_SOL_RESERVE

    if (balanceSol < requiredSol) {
      console.warn(`${label} insufficient balance — need ${requiredSol.toFixed(3)} SOL, have ${balanceSol.toFixed(4)}`)
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_insufficient_balance',
        payload: {
          symbol: metrics.symbol,
          balanceSol,
          requiredSol,
          solAmount,
          meteoraRentReserveSol: METEORA_RENT_RESERVE_SOL,
          walletMinSolReserve: WALLET_MIN_SOL_RESERVE,
        },
      })
      return null
    }

    let poolPubkey: PublicKey
    try {
      poolPubkey = new PublicKey(metrics.poolAddress || '')
    } catch (e: any) {
      console.error(`${label} invalid poolAddress "${metrics.poolAddress}": ${e?.message || e}`)
      await supabase.from('bot_logs').insert({
        level: 'error', event: 'open_position_skipped_bad_pool_address',
        payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress, error: e?.message || String(e) },
      })
      return null
    }

    // Validate that this is a real on-chain DLMM pair (defensive: datapi sometimes lists
    // uninitialized / non-DLMM addresses for fresh pump.fun tokens, which later cause
    // "Invalid public key input" deep inside the Zap/DLMM SDK parser).
    try {
      const poolAccount = await connection.getAccountInfo(poolPubkey)
      const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
      if (!poolAccount || poolAccount.owner.toBase58() !== DLMM_PROGRAM_ID) {
        console.warn(`${label} pool ${metrics.poolAddress} not a valid DLMM lb pair (owner=${poolAccount?.owner.toBase58() ?? 'missing'}) — skipping`)
        await supabase.from('bot_logs').insert({
          level: 'warn', event: 'open_position_skipped_non_dlmm_pool',
          payload: { symbol: metrics.symbol, strategy: strategy.id, poolAddress: metrics.poolAddress },
        })
        return null
      }
    } catch (e: any) {
      console.warn(`${label} pool account lookup failed for ${metrics.poolAddress}: ${e?.message || e} — skipping open`)
      return null
    }

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

    // === EARLY BIN RANGE VALIDATION (before any Jupiter/Zap work) ===
    // We calculate how many bins the strategy's intended % range actually requires
    // on this specific pool's binStep. If it exceeds the strategy's max, we proportionally
    // shrink the range to stay valid. We only reject early if the range is still invalid
    // after shrinking.
    let binsDown = Math.abs(Math.round((strategy.position.rangeDownPct / 100) / (binStep / 10000)));
    let binsUp   = Math.round((strategy.position.rangeUpPct / 100) / (binStep / 10000));
    let binRange = binsDown + binsUp;

    const maxBins = MAX_BINS_BY_STRATEGY[strategy.id] ?? MAX_BINS_DEFAULT;

    if (binRange > maxBins) {
      const shrinkRatio = maxBins / binRange;
      binsDown = Math.floor(binsDown * shrinkRatio);
      binsUp   = maxBins - binsDown;
      binRange = binsDown + binsUp;

      console.log(
        `${label} bin range auto-shrunk to respect strategy limit (${binRange} bins instead of ~${Math.round(binRange / shrinkRatio)})`
      );
    }

    const minBinId = activeBinId - binsDown;
    const maxBinId = activeBinId + binsUp;

    if (binRange < 2 || binRange > maxBins) {
      console.warn(`${label} bin range still invalid after shrinking — rejecting early`, {
        binRange,
        maxBins,
        binStep,
        strategy: strategy.id,
      });
      await supabase.from('bot_logs').insert({
        level: 'warn',
        event: 'open_position_skipped_invalid_bin_range',
        payload: { symbol: metrics.symbol, strategy: strategy.id, binRange, maxBins, binStep },
      });
      return null;
    }

    console.log(`${label} bin range validated: ${minBinId} → ${maxBinId} (${binRange} bins, step=${binStep})`)
    // === END EARLY VALIDATION ===

    // === TOKEN-2022 / pump.fun GRADUATE PATH (primary for these tokens) ===
    // Historical note (from git history):
    // The direct Jupiter + raw DLMM SDK path (with split init + addLiquidity + retries)
    // was the reliable way to consistently open positions on pump.fun graduates.
    // We route Token-2022 tokens to the direct path as the primary route.
    if (isToken2022) {
      console.log(`${label} Token-2022 / pump.fun graduate — routing to direct Jupiter + DLMM SDK path (primary for these tokens)`);

      return await openPositionToken2022(
        metrics,
        strategy,
        dlmmPool,
        outputMint,
        outputTokenProgram,
        solAmount,
        minBinId,
        maxBinId,
        solIsTokenX,
        label,
        await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()]),
        supabase,
        DRY_RUN,
        new Keypair()
      );
    }
    // === END TOKEN-2022 PRIMARY PATH ===

    // Only reach here for normal (legacy Token) pairs — safe to create ATAs
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
      await supabase.from('bot_logs').insert({
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

    // === ZAP-FIRST ARCHITECTURE (with one manual fallback) ===
    // Primary path: Meteora Zap SDK (recommended by current docs) — handles swap + initializePosition2 + add liquidity in one flow.
    // We give it up to 2 attempts (fresh quotes on retry).
    // On total Zap failure we do ONE manual fallback: Jupiter SOL→token swap + direct DLMM SDK initialize + addLiquidity.
    // The early bin-range validation (real binStep + proportional shrink) protects both paths from InvalidPositionWidth (6040).
    const sendZapTx = async (
      tx: Transaction | undefined,
      signers: import('@solana/web3.js').Signer[],
      stage: string,
      attemptLabel: string,
    ): Promise<string | null> => {
      if (!tx || tx.instructions.length === 0) return null
      const sig = await sendLegacyTx(applyPriorityFee(tx, priorityFee), signers, attemptLabel)
      console.log(`${attemptLabel} zap-in ${stage} confirmed ✔ sig: ${sig}`)
      return sig
    }

    let openSig = ''
    let lastZapErr: any = null

    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptLabel = `${label} (attempt ${attempt}/2)`
      let cleanupSentThisAttempt = false

      try {
        console.log(`${attemptLabel} building fresh zap quote...`)

        // Re-fetch active bin for a fresh quote on retry (Token-2022 is already handled before this loop)
        const activeBin = await dlmmPool.getActiveBin()
        const currentActiveBinId = activeBin.binId
        const currentMinDeltaId = minBinId - currentActiveBinId
        const currentMaxDeltaId = maxBinId - currentActiveBinId

        const { estimateDlmmDirectSwap } = await import('@meteora-ag/zap-sdk')
        const directSwapEstimate = await estimateDlmmDirectSwap({
          amountIn,
          inputTokenMint: NATIVE_MINT,
          lbPair: poolPubkey,
          connection,
          swapSlippageBps: DLMM_ZAP_SWAP_SLIPPAGE_BPS,
          minDeltaId: currentMinDeltaId,
          maxDeltaId: currentMaxDeltaId,
          strategy: strategyType,
        })

        console.log(
          `${attemptLabel} DLMM zap-in estimate: input=${amountIn.toString()} lamports ` +
          `solSide=${solIsTokenX ? 'X' : 'Y'} swapAmount=${directSwapEstimate.result.swapAmount.toString()} ` +
          `postX=${directSwapEstimate.result.postSwapX.toString()} postY=${directSwapEstimate.result.postSwapY.toString()}`,
        )

        // Resolve the correct token program for the output mint (critical for Token-2022 / pump.fun tokens)
        const zap = await getZap()
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
        })

        const zapResponse: ZapInDlmmResponse = await zap.buildZapInDlmmTransaction({
          ...zapParams,
          position: positionKeypair.publicKey,
        })

        const sendCleanupThisAttemptFn = async (stage: string): Promise<void> => {
          if (cleanupSentThisAttempt) return
          cleanupSentThisAttempt = true
          try {
            await sendZapTx(zapResponse.cleanUpTransaction, [wallet], stage, attemptLabel)
          } catch (cleanupErr) {
            console.warn(`${attemptLabel} zap-in cleanup failed after ${stage}:`, cleanupErr)
          }
        }

        await sendZapTx(zapResponse.setupTransaction, [wallet], 'setup', attemptLabel)
        for (let i = 0; i < zapResponse.swapTransactions.length; i++) {
          await sendZapTx(zapResponse.swapTransactions[i], [wallet], `swap ${i + 1}/${zapResponse.swapTransactions.length}`, attemptLabel)
        }
        await sendZapTx(zapResponse.ledgerTransaction, [wallet], 'ledger', attemptLabel)
        openSig = await sendZapTx(zapResponse.zapInTransaction, [wallet, positionKeypair], 'position', attemptLabel) ?? ''
        await sendZapTx(zapResponse.cleanUpTransaction, [wallet], 'cleanup', attemptLabel)

        console.log(`${attemptLabel} position opened successfully`)
        break // success — exit retry loop

      } catch (zapErr) {
        lastZapErr = zapErr
        console.warn(`${label} attempt ${attempt}/2 failed:`, zapErr)

        if (attempt === 2) {
          // Final attempt failed — do NOT re-throw here.
          // Let execution fall through to the manual fallback block below.
          break
        }

        // Small delay before retrying with a fresh quote
        await new Promise((r) => setTimeout(r, 1200))
      }
    }

    // Reached after Zap attempts (either success or both failed).
    // This block is now primarily a safety net for legacy (non-Token-2022) tokens.
    if (!openSig && lastZapErr) {
      console.warn(`${label} Zap path exhausted after 2 attempts — trying ONE manual fallback (Jupiter + DLMM SDK)`)
      try {
        return await openPositionToken2022(
          metrics,
          strategy,
          dlmmPool,
          outputMint,
          outputTokenProgram,
          solAmount,
          minBinId,
          maxBinId,
          solIsTokenX,
          label,
          await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()]),
          supabase,
          DRY_RUN,
          new Keypair()
        )
      } catch (manualErr) {
        console.error(`${label} manual fallback also failed — giving up on ${metrics.symbol}`)
        throw manualErr
      }
    }

    let tokenAmountDeposited = 0
    try {
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
      const userPos = userPositions.find(
        p => p.publicKey.toBase58() === positionKeypair.publicKey.toBase58()
      )
      if (userPos) {
        const rawAmount = userPos.positionData.totalXAmount
        tokenAmountDeposited = typeof rawAmount === 'object'
          ? (rawAmount as BN).toNumber() / 1e6
          : Number(rawAmount) / 1e6
        console.log(`${label} token amount deposited: ${tokenAmountDeposited.toFixed(4)}`)
      }
    } catch (err) {
      console.warn(`${label} could not fetch token amount:`, err)
    }

    console.log(`${label} position opened ✔`)
    const positionId = await persistPosition(
      metrics, strategy, openSig,
      metrics.priceUsd ?? 0, entryPriceSol, solAmount,
      positionKeypair.publicKey.toBase58(), tokenAmountDeposited, DRY_RUN
    )
    await sendOpenAlert(metrics, strategy, positionId, solAmount, entryPriceSol)

    return positionId

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    await createServerClient().from('bot_logs').insert({
      level: 'error', event: 'open_position_failed',
      payload: { symbol: metrics.symbol, strategy: strategy.id, error: message, stack: err instanceof Error ? err.stack : undefined },
    })
    return null
  }
}

/**
 * Primary open path for Token-2022 / pump.fun graduates (and safety fallback for legacy tokens).
 *
 * Aggressive robustness version (based on historically working patterns):
 *   1. Jupiter SOL → token swap
 *   2. Split DLMM operations: initializePosition (separate) → addLiquidityByStrategy (with retry + backoff)
 *
 * This split + retry approach was repeatedly proven in older commits to avoid the
 * simulation / InvalidRealloc / transient failures that the combined SDK call often hit
 * on pump.fun Token-2022 graduates.
 */
async function openPositionToken2022(
  metrics: TokenMetrics,
  strategy: Strategy,
  dlmmPool: any,
  outputMint: PublicKey,
  outputTokenProgram: PublicKey,
  solAmount: number,
  minBinId: number,
  maxBinId: number,
  solIsTokenX: boolean,
  attemptLabel: string,
  priorityFee: number,
  supabase: any,
  DRY_RUN: boolean,
  positionKeypair: Keypair
): Promise<string | null> {
  const label = `${attemptLabel}[token2022]`

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return null
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const amountIn = new BN(Math.floor(solAmount * 1e9))

    console.log(`${label} entering manual Token-2022 / pump.fun fallback path`)

    // 1. Swap SOL → token using Jupiter (reliable for Token-2022)
    console.log(`${label} swapping ${solAmount} SOL → ${metrics.symbol} via Jupiter...`)
    const tokenAmountOut = await swapSolToTokenViaJupiter(
      connection,
      wallet,
      outputMint,
      amountIn,
      100 // 1% slippage for safety
    )
    console.log(`${label} received ${tokenAmountOut.toString()} of ${metrics.symbol}`)

    if (tokenAmountOut.isZero()) {
      throw new Error(`${label} Jupiter swap returned zero tokens`)
    }

    console.log(`${label} Jupiter swap successful — proceeding to direct DLMM SDK (split init + add liquidity for robustness)`)

    // Small safety improvement: explicitly ensure the ATA for the Token-2022 output mint exists
    // using the correct token program ID (passed from the caller).
    const outputAta = getAssociatedTokenAddressSync(
      outputMint,
      wallet.publicKey,
      false,
      outputTokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )

    if (!(await connection.getAccountInfo(outputAta))) {
      console.log(`${label} creating ATA for Token-2022 token (${outputMint.toBase58().slice(0, 8)}…)`)
      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        outputAta,
        wallet.publicKey,
        outputMint,
        outputTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )

      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        ataIx
      )

      const ataSig = await sendLegacyTx(ataTx, [wallet], label)
      console.log(`${label} Token-2022 ATA created ✔ sig: ${ataSig}`)
    }

    // 2. Direct DLMM SDK — SPLIT INIT + ADD LIQUIDITY (historical robust pattern)
    // Old commits repeatedly showed that splitting these two operations (instead of the combined
    // initializePositionAndAddLiquidityByStrategy) avoided InvalidRealloc, simulation failures,
    // and other transient SDK issues on pump.fun Token-2022 graduates.
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId

    const minDeltaId = minBinId - activeBinId
    const maxDeltaId = maxBinId - activeBinId

    const strategyType = strategyTypeForDistribution(await getStrategyType(), strategy.position.distributionType)

    // --- Step 2a: Initialize the position first ---
    console.log(`${label} [direct] step 2a/2 — initializing position (separate tx)`)
    try {
      await dlmmPool.initializePosition({
        positionPubKey: positionKeypair.publicKey,
        user: wallet.publicKey,
      })
      console.log(`${label} [direct] position initialized successfully`)
    } catch (initErr: any) {
      console.error(`${label} [direct] initializePosition failed:`, initErr?.message || initErr)
      throw initErr
    }

    // Small delay between the two operations (common in old robust implementations)
    await new Promise(r => setTimeout(r, 1200))

    // --- Step 2b: Add liquidity with retry (aggressive robustness) ---
    // Old working commits used retries + backoff around the add liquidity step
    // because the DLMM SDK can have transient simulation / realloc issues even on split calls.
    console.log(`${label} [direct] step 2b/2 — adding liquidity via addLiquidityByStrategy (with retry)`)
    let userPositions: any[] = []
    const maxRetries = 2
    let lastAddErr: any = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const addResult = await dlmmPool.addLiquidityByStrategy({
          positionPubKey: positionKeypair.publicKey,
          user: wallet.publicKey,
          totalXAmount: solIsTokenX ? new BN(0) : tokenAmountOut,
          totalYAmount: solIsTokenX ? tokenAmountOut : new BN(0),
          strategy: strategyType,
          minBinId,
          maxBinId,
        })
        userPositions = addResult?.userPositions ?? []
        console.log(`${label} [direct] addLiquidityByStrategy succeeded on attempt ${attempt}`)
        break
      } catch (addErr: any) {
        lastAddErr = addErr
        console.warn(`${label} [direct] addLiquidityByStrategy attempt ${attempt}/${maxRetries} failed:`, addErr?.message || addErr)

        if (attempt < maxRetries) {
          const backoffMs = 1500 * attempt
          console.log(`${label} [direct] waiting ${backoffMs}ms before retry...`)
          await new Promise(r => setTimeout(r, backoffMs))
        }
      }
    }

    if (userPositions.length === 0 && lastAddErr) {
      throw lastAddErr
    }

    const userPos = userPositions.find(
      (p: any) => p.publicKey.toBase58() === positionKeypair.publicKey.toBase58()
    )

    if (!userPos) {
      throw new Error(`${label} position was not found after split initialize + addLiquidityByStrategy`)
    }

    const openSig = 'manual-token2022-' + Date.now() // We can improve this later with real signature

    const tokenAmountDeposited = solIsTokenX
      ? (userPos.positionData.totalYAmount as BN).toNumber() / 1e6
      : (userPos.positionData.totalXAmount as BN).toNumber() / 1e6

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

    console.log(`${label} position opened successfully via direct Token-2022 path ✔`)
    return positionId

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    if (err instanceof Error && err.stack) {
      console.error(err.stack)
    }
    await createServerClient().from('bot_logs').insert({
      level: 'error',
      event: 'open_position_token2022_failed',
      payload: { symbol: metrics.symbol, strategy: strategy.id, error: message, stack: err instanceof Error ? err.stack : undefined },
    })
    return null
  }
}

/**
 * Jupiter v1 swap helper: SOL → output token.
 * Used exclusively by the manual Token-2022 fallback path.
 */
async function swapSolToTokenViaJupiter(
  connection: Connection,
  wallet: Keypair,
  outputMint: PublicKey,
  amountIn: BN,
  slippageBps: number = 100
): Promise<BN> {
  // Updated to current Jupiter Swap API v1 (https://dev.jup.ag/docs/swap/v1/get-quote)
  const quoteParams = new URLSearchParams({
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: outputMint.toBase58(),
    amount: amountIn.toString(),
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'false',
  });

  const quoteUrl = `https://api.jup.ag/swap/v1/quote?${quoteParams.toString()}`;

  const quoteRes = await fetch(quoteUrl);

  if (!quoteRes.ok) {
    const text = await quoteRes.text();
    throw new Error(`Jupiter quote failed with ${quoteRes.status}: ${text}`);
  }

  const quote = await quoteRes.json();

  if (quote.error) {
    throw new Error(`Jupiter quote error: ${quote.error}`);
  }

  const swapRes = await fetch('https://api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
  });

  if (!swapRes.ok) {
    const text = await swapRes.text();
    throw new Error(`Jupiter swap failed with ${swapRes.status}: ${text}`);
  }

  const swap = await swapRes.json();

  if (swap.error) {
    throw new Error(`Jupiter swap error: ${swap.error}`);
  }

  const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  return new BN(quote.outAmount);
}
