import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import {
  Keypair, PublicKey, Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
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
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { swapTokenToSol } from '@/lib/swap'
import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'
import { OPEN_LP_STATUSES, assertCanOpenLpPosition, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { STRATEGIES } from '@/strategies'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}
async function getStrategyType() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.StrategyType
}
async function getZap() {
  const mod = await import('@meteora-ag/zap-sdk')
  return new mod.Zap(getConnection())
}

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

const METEORA_RENT_RESERVE_SOL = 0.07
const NATIVE_MINT_STR = NATIVE_MINT.toBase58()

const MARKET_LP_SOL_PER_POSITION = parseFloat(
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.1',
)
const MAX_CONCURRENT_MARKET_LP_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_MARKET_LP_POSITIONS ?? process.env.MAX_CONCURRENT_POSITIONS ?? '5',
)
const MAX_MARKET_LP_SOL_DEPLOYED = parseFloat(process.env.MAX_MARKET_LP_SOL_DEPLOYED ?? process.env.MAX_TOTAL_SOL_DEPLOYED ?? '1')
const WALLET_MIN_SOL_RESERVE    = parseFloat(process.env.WALLET_MIN_SOL_RESERVE    ?? '0.1')

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58()
const COMPUTE_BUDGET_SET_UNIT_LIMIT = 2
const COMPUTE_BUDGET_SET_UNIT_PRICE = 3
const ADD_LIQUIDITY_FALLBACK_CU = 1_400_000
const DLMM_ZAP_SWAP_SLIPPAGE_BPS = 100
const DLMM_ZAP_MAX_ACTIVE_BIN_SLIPPAGE = 3
const DLMM_ZAP_MAX_ACCOUNTS = 48
const DLMM_ZAP_MAX_TRANSFER_EXTEND_PERCENTAGE = 2

function getClaimableFeesUsd(position: Record<string, any>): number | null {
  const value = position.claimable_fees_usd ?? position.metadata?.claimable_fees_usd
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const MAX_BINS_BY_STRATEGY: Record<string, number> = {
  'evil-panda':    200,
  'scalp-spike':   120,
  'bluechip-farm': 100,
  'stable-farm':   100,
}
const MAX_BINS_DEFAULT = 150

interface OpenPositionOptions {
  rebalanceFromPositionId?: string
}

function computeBudgetKind(ix: TransactionInstruction): number | null {
  if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID) return null
  return ix.data[0] ?? null
}

function addPriorityFeeAndPreserveComputeLimit(
  ixs: TransactionInstruction[],
  priorityFee: number,
  fallbackUnits: number,
): TransactionInstruction[] {
  const withoutUnitPrice = ixs.filter(ix => computeBudgetKind(ix) !== COMPUTE_BUDGET_SET_UNIT_PRICE)
  const hasUnitLimit = withoutUnitPrice.some(ix => computeBudgetKind(ix) === COMPUTE_BUDGET_SET_UNIT_LIMIT)

  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    ...(hasUnitLimit ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: fallbackUnits })]),
    ...withoutUnitPrice,
  ]
}

function applyPriorityFee(
  tx: Transaction,
  priorityFee: number,
  fallbackUnits = ADD_LIQUIDITY_FALLBACK_CU,
): Transaction {
  tx.instructions = addPriorityFeeAndPreserveComputeLimit(tx.instructions, priorityFee, fallbackUnits)
  return tx
}

async function simulateAndCheck(tx: Transaction, label: string): Promise<boolean> {
  const connection = getConnection()
  try {
    const sim = await connection.simulateTransaction(tx)
    if (sim.value.err) {
      console.error(`${label} ⚠ simulation FAILED — aborting send`, {
        err:  sim.value.err,
        logs: sim.value.logs?.slice(-5),
      })
      return false
    }
    console.log(`${label} simulation OK (units: ${sim.value.unitsConsumed ?? 'n/a'})`)
    return true
  } catch (simErr: unknown) {
    const msg = simErr instanceof Error ? simErr.message : String(simErr)
    if (msg.includes('memory allocation failed') || msg.includes('out of memory')) {
      console.error(`${label} ⚠ simulation OOM — position too large, aborting`, { error: msg })
      return false
    }
    console.warn(`${label} simulation threw (proceeding):`, msg)
    return true
  }
}

/**
 * Sends a legacy transaction and waits for confirmation.
 *
 * If confirmTransaction throws (RPC timeout, block height expiry, etc.)
 * we fall back to getSignatureStatus. If the chain shows the tx as
 * 'confirmed' or 'finalized' we treat it as success and return the sig
 * — the tx landed, the RPC just timed out waiting. Only re-throws when
 * the chain also has no record of the tx, preventing false-positive
 * active positions.
 */
async function sendLegacyTx(
  tx: Transaction,
  signers: import('@solana/web3.js').Signer[],
  label: string = '[executor]'
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey

  const simOk = await simulateAndCheck(tx, label)
  if (!simOk) throw new Error(`${label} transaction aborted — simulation reported program error`)

  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })

  try {
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  } catch (confirmErr: unknown) {
    const errMsg = confirmErr instanceof Error ? confirmErr.message : String(confirmErr)
    console.warn(`${label} confirmTransaction threw — checking chain directly for ${sig.slice(0, 8)}…`, errMsg)

    // Give the RPC a moment to catch up before we query status
    await new Promise(r => setTimeout(r, 3_000))

    const statusResp = await connection.getSignatureStatus(sig, { searchTransactionHistory: true })
    const status = statusResp.value

    if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      console.log(`${label} tx confirmed on-chain via status fallback ✔ (${status.confirmationStatus}) sig: ${sig}`)
      return sig
    }

    // Chain also has no record — tx genuinely did not land
    console.error(`${label} tx not confirmed on-chain after fallback check — sig: ${sig}`, { status })
    throw confirmErr
  }

  return sig
}

async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
  const connection = getConnection()
  const info = await connection.getAccountInfo(mint)
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  return TOKEN_PROGRAM_ID
}

/**
 * Fallback for the token→SOL swap leg after DLMM liquidity removal.
 * Uses zapOutThroughDlmm which routes through the LB pair directly.
 * Only viable for SOL-paired pools (one side is NATIVE_MINT).
 * Returns true if the zap was sent successfully, false if skipped.
 */
async function zapOutDlmmFallback(
  dlmmPool: any,
  wallet: Keypair,
  lbPairAddress: string,
  label: string
): Promise<boolean> {
  const connection = getConnection()
  const tokenX = dlmmPool.tokenX.publicKey as PublicKey
  const tokenY = dlmmPool.tokenY.publicKey as PublicKey

  const pairHasSol =
    tokenX.toBase58() === NATIVE_MINT_STR ||
    tokenY.toBase58() === NATIVE_MINT_STR

  if (!pairHasSol) {
    console.log(`${label} DLMM zap fallback skipped — pair has no SOL side`)
    return false
  }

  const inputMint = tokenX.toBase58() === NATIVE_MINT_STR ? tokenY : tokenX
  const outputMint = NATIVE_MINT
  const inputTokenProgram = await getTokenProgramId(inputMint)
  const outputTokenProgram = TOKEN_PROGRAM_ID

  const inputAta = getAssociatedTokenAddressSync(
    inputMint,
    wallet.publicKey,
    false,
    inputTokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID
  )

  const bal = await connection.getTokenAccountBalance(inputAta).catch(() => null)
  const amountIn = new BN(bal?.value?.amount ?? '0')

  if (amountIn.isZero()) {
    console.log(`${label} DLMM zap fallback skipped — no token balance to zap`)
    return false
  }

  console.log(`${label} DLMM zap fallback — zapOutThroughDlmm ${amountIn.toString()} lamports of ${inputMint.toBase58().slice(0, 8)}…`)

  const zap = await getZap()
  const tx: Transaction = await (zap as any).zapOutThroughDlmm({
    user: wallet.publicKey,
    lbPairAddress: new PublicKey(lbPairAddress),
    inputMint,
    outputMint,
    inputTokenProgram,
    outputTokenProgram,
    amountIn,
    minimumSwapAmountOut: new BN(0),
    maxSwapAmount: amountIn,
    percentageToZapOut: 100,
  })

  const sig = await sendLegacyTx(tx, [wallet], `${label}[zap-dlmm]`)
  console.log(`${label} DLMM zap fallback ✔ sig: ${sig}`)
  return true
}

function getDecimalAdjustedPrice(dlmmPool: any, activeBin: { price: string; pricePerToken: string }): number {
  try {
    const adjusted = dlmmPool.fromPricePerLamport(Number(activeBin.price))
    const price = parseFloat(adjusted)
    if (isFinite(price) && price > 0) return price
  } catch {}
  return parseFloat(activeBin.pricePerToken)
}

/**
 * Fetches userPositions with up to `maxAttempts` retries spaced `delayMs` apart.
 * Meteora's position API can lag 1–3s behind the chain after a removeLiquidity tx.
 * Returns the matching position or null if still absent after all retries.
 */
async function getPositionWithRetry(
  dlmmPool: any,
  walletPubkey: PublicKey,
  positionPubkey: string,
  label: string,
  maxAttempts = 4,
  delayMs = 1_500
): Promise<any | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPubkey)
    const found = userPositions.find((p: { publicKey: PublicKey }) => p.publicKey.toBase58() === positionPubkey)
    if (found) return found
    if (attempt < maxAttempts) {
      console.log(`${label} position not yet visible in API — retry ${attempt}/${maxAttempts - 1} in ${delayMs}ms`)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  return null
}

function strategyTypeForDistribution(
  strategyTypeEnum: typeof import('@meteora-ag/dlmm').StrategyType,
  distributionType: Strategy['position']['distributionType'],
): StrategyType {
  const strategyTypeMap: Record<string, StrategyType> = {
    spot:      strategyTypeEnum.Spot,
    curve:     strategyTypeEnum.Curve,
    'bid-ask': strategyTypeEnum.BidAsk,
  }
  return strategyTypeMap[distributionType] ?? strategyTypeEnum.Spot
}

function findStrategyForPosition(position: Record<string, any>): Strategy | null {
  const strategyId = position.strategy_id ?? position.metadata?.strategy_id
  return STRATEGIES.find(strategy => strategy.id === strategyId) ?? null
}

async function getTotalDeployedSolForCap(
  supabase: ReturnType<typeof createServerClient>,
  limitState: OpenLpLimitState,
): Promise<{ totalDeployed: number; source: OpenLpLimitState['countSource'] }> {
  if (limitState.liveFetchOk) {
    const livePubkeys = limitState.livePositions
      .map(position => position.position_pubkey)
      .filter(Boolean)

    if (livePubkeys.length === 0) {
      return { totalDeployed: 0, source: limitState.countSource }
    }

    const { data, error } = await supabase
      .from('lp_positions')
      .select('position_pubkey, sol_deposited')
      .in('position_pubkey', livePubkeys)

    if (error) {
      console.warn(`[executor] live exposure DB join failed; using Meteora live estimates: ${error.message}`)
    }

    const cachedSolByPubkey = new Map(
      (data ?? []).map((row: { position_pubkey: string | null; sol_deposited: number | null }) => [
        row.position_pubkey,
        Number(row.sol_deposited ?? 0),
      ]),
    )

    const totalDeployed = limitState.livePositions.reduce((sum, position) => {
      const cachedSol = cachedSolByPubkey.get(position.position_pubkey) ?? 0
      const liveSol = Number(position.sol_deposited ?? 0)
      return sum + (cachedSol > 0 ? cachedSol : liveSol)
    }, 0)

    return { totalDeployed, source: limitState.countSource }
  }

  const { data: openPositions } = await supabase
    .from('lp_positions').select('sol_deposited').in('status', OPEN_LP_STATUSES)
  const totalDeployed = (openPositions ?? []).reduce(
    (sum: number, position: { sol_deposited: number | null }) => sum + Number(position.sol_deposited ?? 0),
    0,
  )

  return { totalDeployed, source: limitState.countSource }
}

export async function addLiquidityToPosition(
  positionId: string,
  solAmount: number,
): Promise<{
  success: boolean
  dryRun: boolean
  txSignature: string
  symbol: string
  solAdded: number
  error?: string
}> {
  const supabase = createServerClient()
  const label = `[executor][add][${positionId}]`

  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return { success: false, dryRun: false, txSignature: '', symbol: positionId, solAdded: solAmount, error: 'SOL amount must be greater than 0' }
  }

  const { data: position, error } = await supabase
    .from('lp_positions')
    .select('*')
    .eq('id', positionId)
    .single()

  if (error || !position) {
    return { success: false, dryRun: false, txSignature: '', symbol: positionId, solAdded: solAmount, error: `position not found: ${error?.message ?? 'null row'}` }
  }

  const symbol = position.symbol ?? position.mint ?? positionId
  if (
    position.position_type === 'damm-edge' ||
    position.position_type === 'damm-migration' ||
    position.strategy_id === 'damm-edge' ||
    position.strategy_id === 'damm-migration' ||
    position.strategy_id === 'damm-live'
  ) {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'adding liquidity is currently supported for DLMM positions only' }
  }
  if (position.status === 'closed') {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'position is already closed' }
  }
  if (!position.position_pubkey || !position.pool_address) {
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'position is missing pool_address or position_pubkey' }
  }

  const strategy = findStrategyForPosition(position)
  if (!strategy) {
    return {
      success: false,
      dryRun: false,
      txSignature: '',
      symbol,
      solAdded: solAmount,
      error: `strategy not found for ${position.strategy_id ?? position.metadata?.strategy_id ?? 'unknown'}`,
    }
  }

  const botState = await getBotState()
  const dryRun = ENV_DRY_RUN_FORCED || botState.dry_run
  if (dryRun) {
    await supabase.from('bot_logs').insert({
      level: 'info',
      event: 'add_liquidity_dry_run',
      payload: { positionId, symbol, solAmount, strategy: strategy.id },
    })
    console.log(`${label} dry_run=true — skipping add liquidity tx`)
    return { success: true, dryRun: true, txSignature: 'DRY_RUN', symbol, solAdded: solAmount }
  }

  const connection = getConnection()
  const wallet = getWallet()
  const balanceSol = await connection.getBalance(wallet.publicKey) / 1e9
  const requiredSol = solAmount + METEORA_RENT_RESERVE_SOL
  if (balanceSol < requiredSol) {
    return {
      success: false,
      dryRun: false,
      txSignature: '',
      symbol,
      solAdded: solAmount,
      error: `insufficient balance — need ${requiredSol.toFixed(3)} SOL, have ${balanceSol.toFixed(4)} SOL`,
    }
  }

  const maxTotalDeployed = MAX_MARKET_LP_SOL_DEPLOYED
  const { data: openPositions } = await supabase
    .from('lp_positions')
    .select('sol_deposited')
    .in('status', OPEN_LP_STATUSES)
  const totalDeployed = (openPositions ?? []).reduce(
    (sum: number, row: { sol_deposited: number | null }) => sum + Number(row.sol_deposited ?? 0),
    0,
  )
  if (totalDeployed + solAmount > maxTotalDeployed) {
    return {
      success: false,
      dryRun: false,
      txSignature: '',
      symbol,
      solAdded: solAmount,
      error: `global exposure cap hit — ${(totalDeployed + solAmount).toFixed(3)}/${maxTotalDeployed} SOL`,
    }
  }

  try {
    const DLMM = await getDLMM()
    const dlmmPool = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubkey = new PublicKey(position.position_pubkey)
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const livePosition = userPositions.find(p => p.publicKey.toBase58() === position.position_pubkey)

    if (!livePosition) {
      return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: 'position is not live in wallet on Meteora' }
    }

    const tokenX = dlmmPool.tokenX.publicKey as PublicKey
    const tokenY = dlmmPool.tokenY.publicKey as PublicKey
    const lamports = new BN(Math.floor(solAmount * 1e9))
    const totalXAmount = tokenX.toBase58() === NATIVE_MINT_STR ? lamports : new BN(0)
    const totalYAmount = tokenY.toBase58() === NATIVE_MINT_STR ? lamports : new BN(0)

    if (totalXAmount.isZero() && totalYAmount.isZero()) {
      return {
        success: false,
        dryRun: false,
        txSignature: '',
        symbol,
        solAdded: solAmount,
        error: 'pool has no SOL side; /add currently supports SOL-paired DLMM positions only',
      }
    }

    const StrategyTypeEnum = await getStrategyType()
    const strategyType = strategyTypeForDistribution(StrategyTypeEnum, strategy.position.distributionType)
    const minBinId = Number(livePosition.positionData.lowerBinId)
    const maxBinId = Number(livePosition.positionData.upperBinId)
    const priorityFee = await getPriorityFee([position.pool_address, wallet.publicKey.toBase58()])

    const rawTx = await dlmmPool.addLiquidityByStrategy({
      positionPubKey: positionPubkey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
      user: wallet.publicKey,
      slippage: 1,
    })

    const tx = new Transaction().add(
      ...addPriorityFeeAndPreserveComputeLimit(
        rawTx.instructions,
        priorityFee,
        ADD_LIQUIDITY_FALLBACK_CU,
      ),
    )
    const sig = await sendLegacyTx(tx, [wallet], label)
    const previousSol = Number(position.sol_deposited ?? 0)
    const metadata = (position.metadata ?? {}) as Record<string, unknown>
    const previousManualAdds = Number(metadata.manual_add_sol_total ?? 0)
    const entrySolPriceUsd = Number(position.entry_price_usd) > 0 && Number(position.entry_price_sol) > 0
      ? Number(position.entry_price_usd) / Number(position.entry_price_sol)
      : 0
    const currentSolPriceUsd = Number(metadata.sol_price_usd ?? metadata.current_sol_price_usd ?? 0)
    const addSolPriceUsd = currentSolPriceUsd > 0 ? currentSolPriceUsd : entrySolPriceUsd
    const parsedManualAddCostUsd = Number(metadata.manual_add_cost_usd ?? metadata.manual_add_estimated_cost_usd ?? 0)
    const previousManualAddCostUsd = Number.isFinite(parsedManualAddCostUsd) ? parsedManualAddCostUsd : 0
    const manualAddCostUsd = addSolPriceUsd > 0
      ? Math.round((previousManualAddCostUsd + solAmount * addSolPriceUsd) * 100) / 100
      : previousManualAddCostUsd

    await supabase
      .from('lp_positions')
      .update({
        sol_deposited: Math.round((previousSol + solAmount) * 1e9) / 1e9,
        metadata: {
          ...metadata,
          manual_add_sol_total: Math.round((previousManualAdds + solAmount) * 1e9) / 1e9,
          manual_add_cost_usd: manualAddCostUsd,
          last_add_liquidity_sol: solAmount,
          last_add_liquidity_tx: sig,
          last_add_liquidity_at: new Date().toISOString(),
          last_add_liquidity_distribution: strategy.position.distributionType,
          last_add_liquidity_sol_price_usd: addSolPriceUsd > 0 ? Math.round(addSolPriceUsd * 100) / 100 : null,
        },
      })
      .eq('id', positionId)

    await supabase.from('bot_logs').insert({
      level: 'info',
      event: 'add_liquidity_success',
      payload: { positionId, symbol, solAmount, strategy: strategy.id, txSignature: sig },
    })

    console.log(`${label} added ${solAmount} SOL to ${symbol} ✔ sig: ${sig}`)
    return { success: true, dryRun: false, txSignature: sig, symbol, solAdded: solAmount }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} add liquidity failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'add_liquidity_failed',
      payload: { positionId, symbol, solAmount, error: message },
    })
    return { success: false, dryRun: false, txSignature: '', symbol, solAdded: solAmount, error: message }
  }
}

export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
  options: OpenPositionOptions = {},
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
    return await persistPosition(metrics, strategy, 'dry-run-sig', metrics.priceUsd ?? 0, 0, dryRunSolAmount, undefined, 0, DRY_RUN)
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

    const poolPubkey = new PublicKey(metrics.poolAddress)
    const DLMM = await getDLMM()
    const dlmmPool  = await DLMM.create(connection, poolPubkey)
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId

    const entryPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin)
    console.log(`${label} entry price: ${entryPriceSol.toFixed(9)} SOL/token (bin ${activeBinId})`)

    const binStep = dlmmPool.lbPair.binStep
    const mintX   = dlmmPool.tokenX.publicKey
    const mintY   = dlmmPool.tokenY.publicKey

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

    const binsDown = Math.abs(Math.round((strategy.position.rangeDownPct / 100) / (binStep / 10_000)))
    const binsUp   = Math.round((strategy.position.rangeUpPct / 100) / (binStep / 10_000))
    const minBinId = activeBinId - binsDown
    const maxBinId = activeBinId + binsUp
    const binRange = binsDown + binsUp

    const maxBins = MAX_BINS_BY_STRATEGY[strategy.id] ?? MAX_BINS_DEFAULT
    if (binRange > maxBins) {
      console.warn(`${label} bin range too wide — rejecting`, { binRange, maxBins, binStep })
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_bin_range_cap',
        payload: { symbol: metrics.symbol, strategy: strategy.id, binRange, maxBins, binStep },
      })
      return null
    }
    console.log(`${label} bin range: ${minBinId} → ${maxBinId} (${binRange} bins, step=${binStep})`)

    const solIsTokenX = mintX.toBase58() === NATIVE_MINT_STR
    const solIsTokenY = mintY.toBase58() === NATIVE_MINT_STR
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
    const { estimateDlmmDirectSwap } = await import('@meteora-ag/zap-sdk')
    const directSwapEstimate = await estimateDlmmDirectSwap({
      amountIn,
      inputTokenMint: NATIVE_MINT,
      lbPair: poolPubkey,
      connection,
      swapSlippageBps: DLMM_ZAP_SWAP_SLIPPAGE_BPS,
      minDeltaId,
      maxDeltaId,
      strategy: strategyType,
    })

    console.log(
      `${label} DLMM zap-in estimate: input=${amountIn.toString()} lamports ` +
      `solSide=${solIsTokenX ? 'X' : 'Y'} swapAmount=${directSwapEstimate.result.swapAmount.toString()} ` +
      `postX=${directSwapEstimate.result.postSwapX.toString()} postY=${directSwapEstimate.result.postSwapY.toString()}`,
    )

    const zap = await getZap()
    const zapParams = await zap.getZapInDlmmDirectParams({
      user: wallet.publicKey,
      lbPair: poolPubkey,
      inputTokenMint: NATIVE_MINT,
      amountIn,
      maxActiveBinSlippage: DLMM_ZAP_MAX_ACTIVE_BIN_SLIPPAGE,
      minDeltaId,
      maxDeltaId,
      strategy: strategyType,
      favorXInActiveId,
      maxAccounts: DLMM_ZAP_MAX_ACCOUNTS,
      swapSlippageBps: DLMM_ZAP_SWAP_SLIPPAGE_BPS,
      maxTransferAmountExtendPercentage: DLMM_ZAP_MAX_TRANSFER_EXTEND_PERCENTAGE,
      directSwapEstimate: directSwapEstimate.result,
    })
    const positionKeypair = new Keypair()
    const zapResponse: ZapInDlmmResponse = await zap.buildZapInDlmmTransaction({
      ...zapParams,
      position: positionKeypair.publicKey,
    })

    const sendZapTx = async (
      tx: Transaction | undefined,
      signers: import('@solana/web3.js').Signer[],
      stage: string,
    ): Promise<string | null> => {
      if (!tx || tx.instructions.length === 0) return null
      const sig = await sendLegacyTx(applyPriorityFee(tx, priorityFee), signers, label)
      console.log(`${label} zap-in ${stage} confirmed ✔ sig: ${sig}`)
      return sig
    }

    let cleanupSent = false
    const sendCleanup = async (stage: string): Promise<void> => {
      if (cleanupSent) return
      cleanupSent = true
      try {
        await sendZapTx(zapResponse.cleanUpTransaction, [wallet], stage)
      } catch (cleanupErr) {
        console.warn(`${label} zap-in cleanup failed after ${stage}:`, cleanupErr)
      }
    }

    let openSig = ''
    try {
      await sendZapTx(zapResponse.setupTransaction, [wallet], 'setup')
      for (let i = 0; i < zapResponse.swapTransactions.length; i++) {
        await sendZapTx(zapResponse.swapTransactions[i], [wallet], `swap ${i + 1}/${zapResponse.swapTransactions.length}`)
      }
      await sendZapTx(zapResponse.ledgerTransaction, [wallet], 'ledger')
      openSig = await sendZapTx(zapResponse.zapInTransaction, [wallet, positionKeypair], 'position') ?? ''
      await sendCleanup('cleanup')
    } catch (zapErr) {
      await sendCleanup('failed-open')
      throw zapErr
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
    return await persistPosition(
      metrics, strategy, openSig,
      metrics.priceUsd ?? 0, entryPriceSol, solAmount,
      positionKeypair.publicKey.toBase58(), tokenAmountDeposited, DRY_RUN
    )

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error', event: 'open_position_failed',
      payload: { symbol: metrics.symbol, strategy: strategy.id, error: message },
    })
    return null
  }
}

export async function closePosition(
  positionId: string,
  reason: string
): Promise<boolean> {
  const supabase = createServerClient()

  const { data: position, error } = await supabase
    .from('lp_positions').select('*').eq('id', positionId).single()

  if (error || !position) {
    console.error(`[executor] closePosition: LP position ${positionId} not found`)
    return false
  }

  const label = `[executor][close][${position.symbol}]`
  console.log(`${label} closing — reason: ${reason}`)

  if (position.dry_run === true) {
    console.log(`${label} DRY RUN row — marking closed in DB only`)
    const claimableFeesUsd = getClaimableFeesUsd(position) ?? 0
    await markPositionClosed(positionId, claimableFeesUsd, reason)
    await sendCloseAlert(position, claimableFeesUsd, reason)
    return true
  }

  if (ENV_DRY_RUN_FORCED) {
    console.warn(`${label} BOT_DRY_RUN=true — refusing to close live on-chain position`)
    await supabase.from('bot_logs').insert({
      level: 'warn',
      event: 'close_position_skipped_env_dry_run',
      payload: { positionId, reason },
    })
    return false
  }

  if (!position.position_pubkey) {
    console.error(`${label} position_pubkey is null — cannot close on-chain, marking closed in DB`)
    await markPositionClosed(positionId, getClaimableFeesUsd(position) ?? 0, `${reason}_no_pubkey`)
    return false
  }

  const connection = getConnection()
  const wallet     = getWallet()

  try {
    const DLMM = await getDLMM()
    const dlmmPool       = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubKey = new PublicKey(position.position_pubkey)

    let claimableFeesUsd = getClaimableFeesUsd(position) ?? 0
    try {
      const claimTxs = await dlmmPool.claimAllRewards({
        owner:     wallet.publicKey,
        positions: [{ publicKey: positionPubKey } as never],
      })
      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        const sig = await sendLegacyTx(tx, [wallet], label)
        console.log(`${label} fees claimed ✔ sig: ${sig}`)
      }
    } catch (err) {
      console.warn(`${label} fee claim failed (continuing):`, err)
    }

    // Retry getPositionsByUserAndLbPair to tolerate 1–3s Meteora API lag after chain TX
    const userPosition = await getPositionWithRetry(
      dlmmPool,
      wallet.publicKey,
      positionPubKey.toBase58(),
      label
    )

    if (userPosition) {
      const { lowerBinId, upperBinId } = userPosition.positionData
      const removeTx = await dlmmPool.removeLiquidity({
        position:  positionPubKey,
        user:      wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId:   upperBinId,
        bps:       new BN(10_000),
        shouldClaimAndClose: true,
      })
      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendLegacyTx(tx, [wallet], label)
        console.log(`${label} liquidity removed ✔ sig: ${sig}`)
      }
    } else {
      console.warn(`${label} position not found on-chain after retries — marking closed in DB`)
      await markPositionClosed(positionId, claimableFeesUsd, `${reason}_external`)
      await sendCloseAlert(position, claimableFeesUsd, reason)
      return true
    }

    let swappedToSol = false
    try {
      await swapTokenToSol(position.mint, label)
      swappedToSol = true
    } catch (swapErr) {
      const swapMsg = swapErr instanceof Error ? swapErr.message : String(swapErr)
      console.warn(`${label} token→SOL swap failed — trying DLMM zap fallback:`, swapMsg)

      try {
        swappedToSol = await zapOutDlmmFallback(dlmmPool, wallet, position.pool_address, label)
      } catch (zapErr) {
        console.warn(`${label} DLMM zap fallback failed:`, zapErr)
      }

      if (!swappedToSol) {
        console.error(`${label} token→SOL swap failed after all retries — tokens are stranded in wallet`, { mint: position.mint, error: swapMsg })

        await supabase.from('bot_logs').insert({
          level: 'error',
          event: 'swap_token_to_sol_failed',
          payload: { positionId, mint: position.mint, reason, error: swapMsg },
        })

        await sendAlert({
          type: 'error',
          message: `⚠️ Swap failed for ${position.symbol} after close (${reason})\nMint: \`${position.mint}\`\nTokens are stranded in wallet — manual swap required.\nError: ${swapMsg}`,
        })
      }
    }

    await markPositionClosed(positionId, claimableFeesUsd, reason)
    await sendCloseAlert(position, claimableFeesUsd, reason)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} close failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error', event: 'close_position_failed',
      payload: { positionId, reason, error: message },
    })
    return false
  }
}

async function sendCloseAlert(position: any, claimableFeesUsd: number, reason: string): Promise<void> {
  try {
    const openedAt  = position.opened_at ? new Date(position.opened_at).getTime() : Date.now()
    const ageHours  = parseFloat(((Date.now() - openedAt) / 3_600_000).toFixed(1))

    await sendAlert({
      type:          'position_closed',
      symbol:        position.symbol,
      strategy:      position.metadata?.strategy_id ?? 'unknown',
      reason,
      claimableFeesUsd: Math.round(claimableFeesUsd * 100) / 100,
      ilPct:         0,
      ageHours,
    })
  } catch (alertErr) {
    console.warn('[executor] sendCloseAlert failed (non-fatal):', alertErr)
  }
}

async function persistPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
  sig: string,
  entryPriceUsd: number,
  entryPriceSol: number,
  solDeposited: number,
  positionPubKey?: string,
  tokenAmount: number = 0,
  dryRun: boolean = ENV_DRY_RUN_FORCED,
  needsLiquidityRetry: boolean = false
): Promise<string> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('lp_positions')
    .insert({
      mint:            metrics.address,
      symbol:          metrics.symbol,
      pool_address:    metrics.poolAddress,
      position_pubkey: positionPubKey ?? null,
      token_amount:    tokenAmount,
      sol_deposited:   solDeposited,
      entry_price_usd: entryPriceUsd,
      entry_price_sol: entryPriceSol,
      claimable_fees_usd: 0,
      position_value_usd: 0,
      status:          needsLiquidityRetry ? 'pending_retry' : 'active',
      in_range:        true,
      dry_run:         dryRun,
      opened_at:       new Date().toISOString(),
      tx_open:         sig,
      metadata: {
        strategy_id:           strategy.id,
        bin_range_down:        strategy.position.rangeDownPct,
        bin_range_up:          strategy.position.rangeUpPct,
        maxDurationHours:      strategy.exits.maxDurationHours,
        stop_loss_pct:         strategy.exits.stopLossPct,
        take_profit_pct:       strategy.exits.takeProfitPct,
        out_of_range_minutes:  strategy.exits.outOfRangeMinutes,
        market_cap_usd:        metrics.mcUsd,
        volume_24h_usd:        metrics.volume24h,
        dex_liquidity_usd:     metrics.liquidityUsd,
        fee_tvl_24h_pct:       metrics.feeTvl24hPct,
        rugcheck_score:        metrics.rugcheckScore,
        top_holder_pct:        metrics.topHolderPct,
        holder_count:          metrics.holderCount,
        quote_token_mint:      metrics.quoteTokenMint ?? null,
        bin_step:              metrics.binStep ?? null,
        dex_id:                metrics.dexId,
        dex_price_usd:         metrics.priceUsd,
        entry_sol_price_usd:   entryPriceSol > 0 ? entryPriceUsd / entryPriceSol : null,
        needs_liquidity_retry: needsLiquidityRetry,
      },
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to persist LP position: ${error.message}`)
  return data.id
}

/**
 * Marks a DLMM position closed and preserves the latest Meteora-sourced
 * claimable_fees_usd snapshot. DLMM realized PnL is not computed locally.
 */
async function markPositionClosed(
  positionId: string,
  claimableFeesUsd: number | null,
  reason: string
): Promise<void> {
  const supabase = createServerClient()

  await supabase
    .from('lp_positions')
    .update({
      status:            'closed',
      closed_at:         new Date().toISOString(),
      oor_since_at:      null,
      close_reason:      reason,
      ...(claimableFeesUsd !== null ? { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 } : {}),
    })
    .eq('id', positionId)
}
