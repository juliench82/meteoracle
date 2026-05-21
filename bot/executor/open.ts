/**
 * bot/executor/open.ts
 *
 * DLMM position opening logic extracted from the monolithic executor.ts.
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
import { openMoonboyPosition } from '../moonboy-executor'

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

    console.log(`${label} Token program resolved for output mint ${outputMint.toBase58().slice(0, 8)} → ${isToken2022 ? 'Token-2022' : 'Legacy Token'}`);

    // Zap is now the default path for everything (per latest Meteora docs).
    // Manual path (Jupiter + direct DLMM) is only attempted once as fallback if Zap fails.

    // Fixed bin-range calculation to prevent InvalidPositionWidth errors on DLMM
    const pctDown = Math.abs(strategy.position.rangeDownPct) / 100
    const pctUp = strategy.position.rangeUpPct / 100

    const binsDown = Math.max(1, Math.round(pctDown / (binStep / 10000)))
    const binsUp = Math.max(1, Math.round(pctUp / (binStep / 10000)))

    const minBinId = activeBinId - binsDown
    const maxBinId = activeBinId + binsUp
    const binRange = binsDown + binsUp
    const maxBins = MAX_BINS_BY_STRATEGY[strategy.id] ?? MAX_BINS_DEFAULT

    if (binRange < 2 || binRange > maxBins) {
      console.warn(`${label} invalid bin range — rejecting`, { binRange, maxBins, binStep })
      await supabase.from('bot_logs').insert({
        level: 'warn',
        event: 'open_position_skipped_invalid_bin_range',
        payload: { symbol: metrics.symbol, strategy: strategy.id, binRange, maxBins, binStep },
      })
      return null
    }

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

    // Reuse the bin range calculated earlier (single source of truth)
    if (binRange > maxBins) {
      console.warn(`${label} bin range too wide — rejecting`, { binRange, maxBins, binStep })
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_bin_range_cap',
        payload: { symbol: metrics.symbol, strategy: strategy.id, binRange, maxBins, binStep },
      })
      return null
    }
    console.log(`${label} bin range: ${minBinId} → ${maxBinId} (${binRange} bins, step=${binStep})`)

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

      const sendCleanupThisAttempt = async (stage: string) => {
        if (cleanupSentThisAttempt) return
        cleanupSentThisAttempt = true
        try {
          // We need the latest zapResponse for this attempt
          // (it will be defined in the try block below)
        } catch (e) {
          console.warn(`${attemptLabel} cleanup helper error:`, e)
        }
      }

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
          // Final attempt failed — re-throw so existing error handling runs
          throw zapErr
        }

        // Small delay before retrying with a fresh quote
        await new Promise((r) => setTimeout(r, 1200))
      }
    }

    // If we reach here on attempt 2 without breaking, the error was already thrown above
    if (!openSig && lastZapErr) {
      console.warn(`${label} Zap path failed after 2 attempts. Trying manual fallback once (Jupiter + direct DLMM)...`);
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
        console.error(`${label} Manual fallback also failed. Giving up on ${metrics.symbol}.`);
        throw manualErr;
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

    // Moonboy companion buy — fire-and-forget
    const solPriceUsd = entryPriceSol > 0 && (metrics.priceUsd ?? 0) > 0
      ? (metrics.priceUsd ?? 0) / entryPriceSol
      : 0
    openMoonboyPosition(metrics, solPriceUsd).catch((err: any) =>
      console.warn('[executor] openMoonboyPosition non-fatal error:', err?.message ?? err)
    )

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
 * Manual open path for Token-2022 output tokens (e.g. many pump.fun graduations).
 * Uses Jupiter for the SOL → token swap + DLMM SDK for adding liquidity.
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

    console.log(`${label} ENTERING manual Token-2022 / pump.fun graduate path`);

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

    console.log(`${label} Jupiter swap successful — proceeding to direct DLMM SDK liquidity addition (manual path)`);

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

    // 2. Add liquidity using the DLMM SDK (one-sided on the token side)
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId

    const minDeltaId = minBinId - activeBinId
    const maxDeltaId = maxBinId - activeBinId

    console.log(`${label} adding liquidity with DLMM SDK (Token-2022 path)...`)

    const { userPositions } = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: solIsTokenX ? new BN(0) : tokenAmountOut,
      totalYAmount: solIsTokenX ? tokenAmountOut : new BN(0),
      strategy: strategyTypeForDistribution(await getStrategyType(), strategy.position.distributionType),
      minBinId,
      maxBinId,
      // The DLMM SDK will use the correct program based on the pool
    })

    const userPos = userPositions.find(
      (p: any) => p.publicKey.toBase58() === positionKeypair.publicKey.toBase58()
    )

    if (!userPos) {
      throw new Error(`${label} position was not found after initializePositionAndAddLiquidityByStrategy`)
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

    console.log(`${label} Token-2022 / pump.fun graduate position opened successfully via manual path ✔`)
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
 * Simple Jupiter swap: SOL → Token (works for both legacy and Token-2022)
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
