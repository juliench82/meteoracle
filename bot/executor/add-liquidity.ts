/**
 * bot/executor/add-liquidity.ts
 *
 * Manual liquidity addition to existing DLMM positions.
 * Extracted from the monolithic executor.ts.
 */

import { PublicKey, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js'
import BN from 'bn.js'

import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import type { Strategy } from '@/lib/types'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { STRATEGIES } from '@/strategies'

import {
  simulateAndCheck,
  sendLegacyTx,
  applyPriorityFee,
  addPriorityFeeAndPreserveComputeLimit,
} from '@/lib/solana-tx'

import { persistPosition } from './persistence'
import { logInfo, logError } from '@/lib/log'
import { getOpenLpPositions } from '@/lib/local-state'
import {
  getDLMM,
  getStrategyType,
  findStrategyForPosition,
  strategyTypeForDistribution,
  getTotalDeployedSolForCap,
  getTokenProgramId,
  NATIVE_MINT_STR,
  METEORA_RENT_RESERVE_SOL,
  ADD_LIQUIDITY_FALLBACK_CU,
  MAX_MARKET_LP_SOL_DEPLOYED,
} from './utils'

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'



export async function addLiquidityToPosition(
  positionId: string,
  solAmount: number,
) {
  const label = `[executor][add][${positionId}]`

  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return { success: false, dryRun: false, txSignature: '', symbol: positionId, solAdded: solAmount, error: 'SOL amount must be greater than 0' }
  }

  // Simplified stack: use local state instead of Supabase
  const positions = getOpenLpPositions()
  const position = positions.find(p => p.id === positionId)

  if (!position) {
    return { success: false, dryRun: false, txSignature: '', symbol: positionId, solAdded: solAmount, error: `position not found in local state` }
  }

  const symbol = position.symbol ?? position.mint ?? positionId

  if (position.status === 'closed') {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'position is already closed' }
  }

  if (!position.position_pubkey || !position.pool_address) {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'position is missing pool_address or position_pubkey' }
  }

  const strategy = findStrategyForPosition(position);

  if (!strategy) {
    return {
      success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount,
      error: `strategy not found for ${position.strategy_id ?? position.metadata?.strategy_id ?? 'unknown'}`,
    }
  }

  const botState = await getBotState()
  const dryRun = ENV_DRY_RUN_FORCED || botState.dry_run

  if (dryRun) {
    logInfo('add_liquidity_dry_run', { positionId, symbol, solAmount, strategy: strategy.id })
    console.log(`${label} dry_run=true — skipping add liquidity tx`)
    return { success: true, dryRun: true, txSignature: 'DRY_RUN', symbol, solAdded: solAmount }
  }

  const connection = getConnection()
  const wallet = getWallet()
  const balanceSol = await connection.getBalance(wallet.publicKey) / 1e9
  const requiredSol = solAmount + METEORA_RENT_RESERVE_SOL

  if (balanceSol < requiredSol) {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: `insufficient balance — need ${requiredSol.toFixed(3)} SOL` }
  }

  const maxTotalDeployed = MAX_MARKET_LP_SOL_DEPLOYED
  const { totalDeployed } = await getTotalDeployedSolForCap(await getOpenLpLimitState());

  if (totalDeployed + solAmount > maxTotalDeployed) {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: `global exposure cap hit` }
  }

  try {
    const DLMM = await getDLMM();
    const dlmmPool = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubkey = new PublicKey(position.position_pubkey)
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const livePosition = userPositions.find((p: any) => p.publicKey.toBase58() === position.position_pubkey)

    if (!livePosition) {
      return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'position is not live in wallet on Meteora' }
    }

    const tokenX = dlmmPool.tokenX.publicKey as PublicKey
    const tokenY = dlmmPool.tokenY.publicKey as PublicKey
    const lamports = new BN(Math.floor(solAmount * 1e9))
    const totalXAmount = tokenX.toBase58() === NATIVE_MINT_STR ? lamports : new BN(0)
    const totalYAmount = tokenY.toBase58() === NATIVE_MINT_STR ? lamports : new BN(0)

    if (totalXAmount.isZero() && totalYAmount.isZero()) {
      return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'pool has no SOL side' }
    }

    const StrategyTypeEnum = await getStrategyType();
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType);

    const priorityFee = await getPriorityFee([position.pool_address, wallet.publicKey.toBase58()])

    const rawTx = await dlmmPool.addLiquidityByStrategy({
      positionPubKey: positionPubkey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId: Number(livePosition.positionData.lowerBinId), maxBinId: Number(livePosition.positionData.upperBinId), strategyType },
      user: wallet.publicKey,
      slippage: 1,
    })

    const tx = new Transaction().add(
      ...addPriorityFeeAndPreserveComputeLimit(rawTx.instructions, priorityFee, ADD_LIQUIDITY_FALLBACK_CU),
    )

    const sig = await sendLegacyTx(tx, [wallet], label)

    // TODO: persist updated sol_deposited via local state once the refactor lands
    // (Supabase path removed)

    logInfo('add_liquidity_success', { positionId, symbol, solAmount, strategy: strategy.id, txSignature: sig })

    console.log(`${label} added ${solAmount} SOL to ${symbol} ✔ sig: ${sig}`)
    return { success: true, dryRun: false, txSignature: sig, symbol, solAdded: solAmount }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} add liquidity failed:`, message)
    logError('add_liquidity_failed', { positionId, symbol, solAmount, error: message })
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: message }
  }
}