import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

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
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { swapTokenToSol } from '@/lib/swap'
import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'

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
  return new (mod as any).Zap(getConnection())
}

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

const METEORA_RENT_RESERVE_SOL = 0.07
const NATIVE_MINT_STR = NATIVE_MINT.toBase58()

const MAX_SOL_PER_POSITION      = parseFloat(process.env.MAX_SOL_PER_POSITION      ?? '0.05')
const MAX_CONCURRENT_POSITIONS  = parseInt(process.env.MAX_CONCURRENT_POSITIONS    ?? '5')
const WALLET_RESERVE_MULTIPLIER = parseFloat(process.env.WALLET_RESERVE_MULTIPLIER ?? '1.5')

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58()

const MAX_BINS_BY_STRATEGY: Record<string, number> = {
  'evil-panda':    200,
  'scalp-spike':   120,
  'bluechip-farm': 100,
  'stable-farm':   100,
}
const MAX_BINS_DEFAULT = 150

interface LiquidityStrategyParams {
  minBinId: number
  maxBinId: number
  strategyType: StrategyType
}

function stripComputeBudgetIxs(ixs: TransactionInstruction[]): TransactionInstruction[] {
  return ixs.filter(ix => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID)
}

function toIxArray(ix: TransactionInstruction | TransactionInstruction[]): TransactionInstruction[] {
  return Array.isArray(ix) ? ix : [ix]
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

async function waitForPositionAccountReady(
  dlmmPool: Awaited<ReturnType<Awaited<ReturnType<typeof getDLMM>>['create']>>,
  positionPubkey: PublicKey,
  walletPubkey: PublicKey,
  label: string,
  maxAttempts = 15,
  intervalMs = 2000
): Promise<void> {
  const connection = getConnection()
  const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')

  for (let i = 1; i <= maxAttempts; i++) {
    const info = await connection.getAccountInfo(positionPubkey, 'confirmed')
    if (!info || !info.owner.equals(DLMM_PROGRAM_ID)) {
      console.log(`${label} [wait] account not yet owned by DLMM… attempt ${i}/${maxAttempts}`)
      await new Promise(r => setTimeout(r, intervalMs))
      continue
    }
    try {
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(walletPubkey)
      const found = userPositions.find(p => p.publicKey.toBase58() === positionPubkey.toBase58())
      if (found?.positionData?.lowerBinId !== undefined) {
        console.log(`${label} [wait] position ready on-chain (attempt ${i}/${maxAttempts})`)
        await new Promise(r => setTimeout(r, 2500))
        return
      }
    } catch { /* transient */ }
    console.log(`${label} [wait] owned but DLMM state not ready… attempt ${i}/${maxAttempts}`)
    await new Promise(r => setTimeout(r, intervalMs))
  }
  console.warn(`${label} [wait] not confirmed after ${maxAttempts} attempts — adding 5s safety delay`)
  await new Promise(r => setTimeout(r, 5000))
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

export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy
): Promise<string | null> {
  const label = `[executor][${strategy.id}][${metrics.symbol}]`
  console.log(`${label} opening position`)

  const botState = await getBotState()
  const DRY_RUN = ENV_DRY_RUN_FORCED || botState.dry_run
  const supabase = createServerClient()

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    const envCap = parseFloat(process.env.MAX_SOL_PER_POSITION ?? '0.05')
    const dryRunSolAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap
    return await persistPosition(metrics, strategy, 'dry-run-sig', metrics.priceUsd ?? 0, 0, dryRunSolAmount, undefined, 0, DRY_RUN)
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const envCap = parseFloat(process.env.MAX_SOL_PER_POSITION ?? '0.05')
    const solAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap

    const maxTotalDeployed = parseFloat(process.env.MAX_TOTAL_SOL_DEPLOYED ?? '1')
    const { data: openPositions } = await supabase
      .from('lp_positions').select('sol_deposited').eq('status', 'active')
    const totalDeployed = (openPositions ?? []).reduce(
      (s: number, p: { sol_deposited: number }) => s + (p.sol_deposited ?? 0), 0
    )
    if (totalDeployed + solAmount > maxTotalDeployed) {
      console.warn(`${label} global exposure cap hit — ${totalDeployed.toFixed(3)} SOL deployed`)
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_exposure_cap',
        payload: { symbol: metrics.symbol, totalDeployed, solAmount, maxTotalDeployed },
      })
      return null
    }

    const defaultCooldownHours   = parseFloat(process.env.TOKEN_COOLDOWN_HOURS          ?? '6')
    const emergencyCooldownHours = parseFloat(process.env.TOKEN_EMERGENCY_COOLDOWN_HOURS ?? '1')

    const { data: lastClose } = await supabase
      .from('lp_positions')
      .select('id, close_reason, closed_at')
      .eq('mint', metrics.address)
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(1)

    if (lastClose?.length) {
      const isEmergency   = lastClose[0].close_reason?.startsWith('emergency_stop')
      const cooldownHours = isEmergency ? emergencyCooldownHours : defaultCooldownHours
      const cutoff        = new Date(Date.now() - cooldownHours * 3_600_000).toISOString()
      if (lastClose[0].closed_at >= cutoff) {
        console.warn(`${label} token in cooldown — closed within last ${cooldownHours}h`)
        await supabase.from('bot_logs').insert({
          level: 'warn', event: 'open_position_skipped_cooldown',
          payload: { symbol: metrics.symbol, cooldownHours, closeReason: lastClose[0].close_reason },
        })
        await sendAlert({ type: 'cooldown_skip', symbol: metrics.symbol, strategy: strategy.id, cooldownHours })
        return null
      }
    }

    const balanceLamports = await connection.getBalance(wallet.publicKey)
    const balanceSol = balanceLamports / 1e9
    console.log(`${label} wallet balance: ${balanceSol.toFixed(4)} SOL`)

    const currentOpenCount = (openPositions ?? []).length
    const remainingSlots   = Math.max(0, MAX_CONCURRENT_POSITIONS - currentOpenCount - 1)
    const dynamicReserve   = remainingSlots * MAX_SOL_PER_POSITION * WALLET_RESERVE_MULTIPLIER
    const requiredSol      = solAmount + METEORA_RENT_RESERVE_SOL + dynamicReserve

    if (balanceSol < requiredSol) {
      console.warn(`${label} insufficient balance — need ${requiredSol.toFixed(3)} SOL, have ${balanceSol.toFixed(4)}`)
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_insufficient_balance',
        payload: { symbol: metrics.symbol, balanceSol, requiredSol },
      })
      return null
    }

    const DLMM = await getDLMM()
    const dlmmPool  = await DLMM.create(connection, new PublicKey(metrics.poolAddress))
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

    const lamports = Math.floor(solAmount * 1e9)
    const solBias  = strategy.position.solBias ?? 0.5
    const totalX   = new BN(Math.floor(lamports * (1 - solBias)))
    const totalY   = new BN(Math.floor(lamports * solBias))
    console.log(`${label} deposit split: X=${totalX.toString()} Y=${totalY.toString()} lamports (solBias=${solBias})`)

    const StrategyTypeEnum = await getStrategyType()
    const strategyTypeMap: Record<string, StrategyType> = {
      spot:      StrategyTypeEnum.Spot,
      curve:     StrategyTypeEnum.Curve,
      'bid-ask': StrategyTypeEnum.BidAsk,
    }
    const strategyType: StrategyType = strategyTypeMap[strategy.position.distributionType] ?? StrategyTypeEnum.Spot
    const liqStrategyParams: LiquidityStrategyParams = { minBinId, maxBinId, strategyType }

    const priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

    const keypairFactory = async (count: number): Promise<Keypair[]> =>
      Array.from({ length: count }, () => new Keypair())

    const response = await dlmmPool.initializeMultiplePositionAndAddLiquidityByStrategy(
      keypairFactory,
      totalX,
      totalY,
      liqStrategyParams,
      wallet.publicKey,
      wallet.publicKey,
      1
    )

    let lastSig = ''
    let posIndex = 0
    const total = response.instructionsByPositions.length
    console.log(`${label} opening ${total} position segment(s)`)

    let positionKeypairForQuery: Keypair | null = null

    for (const { positionKeypair, initializePositionIx, addLiquidityIxs } of response.instructionsByPositions) {
      if (!positionKeypairForQuery) positionKeypairForQuery = positionKeypair
      posIndex++

      console.log(`${label} segment ${posIndex}/${total}`, {
        mint: metrics.address, strategy: strategy.id,
        binRange: `${minBinId} → ${maxBinId} (${binRange} bins)`, binStep,
      })

      const rawInitIxs = toIxArray(initializePositionIx as TransactionInstruction | TransactionInstruction[])
      const initIxs    = stripComputeBudgetIxs(rawInitIxs)
      const initTx     = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        ...initIxs
      )
      lastSig = await sendLegacyTx(initTx, [wallet, positionKeypair], label)
      console.log(`${label} seg ${posIndex}/${total} init confirmed ✔ sig: ${lastSig}`)

      await waitForPositionAccountReady(dlmmPool, positionKeypair.publicKey, wallet.publicKey, label)

      try {
        const chunks = (addLiquidityIxs as TransactionInstruction[][]).length > 0
          ? addLiquidityIxs as TransactionInstruction[][]
          : [[...(addLiquidityIxs as unknown as TransactionInstruction[])]]

        for (let ci = 0; ci < chunks.length; ci++) {
          const liqIxs = stripComputeBudgetIxs(chunks[ci])
          const liqTx  = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
            ...liqIxs
          )
          lastSig = await sendLegacyTx(liqTx, [wallet], label)
          console.log(`${label} seg ${posIndex}/${total} liq chunk ${ci + 1}/${chunks.length} confirmed ✔ sig: ${lastSig}`)
        }
      } catch (liqErr: unknown) {
        const liqMsg = liqErr instanceof Error ? liqErr.message : String(liqErr)
        console.error(`${label} seg ${posIndex}/${total} addLiquidity failed — persisting as pending_retry`, { error: liqMsg })
        await supabase.from('bot_logs').insert({
          level: 'error', event: 'add_liquidity_failed',
          payload: {
            symbol: metrics.symbol, strategy: strategy.id,
            positionPubkey: positionKeypair.publicKey.toBase58(),
            initSig: lastSig, error: liqMsg,
          },
        })
        return await persistPosition(
          metrics, strategy, lastSig,
          metrics.priceUsd ?? 0, entryPriceSol, solAmount,
          positionKeypair.publicKey.toBase58(), 0, DRY_RUN, true
        )
      }
    }

    let tokenAmountDeposited = 0
    if (positionKeypairForQuery) {
      try {
        const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
        const userPos = userPositions.find(
          p => p.publicKey.toBase58() === positionKeypairForQuery!.publicKey.toBase58()
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
    }

    console.log(`${label} position opened ✔`)
    const firstPubKey = response.instructionsByPositions[0]?.positionKeypair?.publicKey?.toBase58()
    return await persistPosition(
      metrics, strategy, lastSig,
      metrics.priceUsd ?? 0, entryPriceSol, solAmount,
      firstPubKey, tokenAmountDeposited, DRY_RUN
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
    await markPositionClosed(positionId, position.fees_earned_sol ?? 0, reason, position)
    await sendCloseAlert(position, position.fees_earned_sol ?? 0, reason)
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
    await markPositionClosed(positionId, position.fees_earned_sol ?? 0, `${reason}_no_pubkey`, position)
    return false
  }

  const connection = getConnection()
  const wallet     = getWallet()

  try {
    const DLMM = await getDLMM()
    const dlmmPool       = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubKey = new PublicKey(position.position_pubkey)

    let feesClaimedSol = 0
    try {
      const claimTxs = await dlmmPool.claimAllRewards({
        owner:     wallet.publicKey,
        positions: [{ publicKey: positionPubKey } as never],
      })
      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        const sig = await sendLegacyTx(tx, [wallet], label)
        console.log(`${label} fees claimed ✔ sig: ${sig}`)
      }
      feesClaimedSol = position.fees_earned_sol ?? 0
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
      await markPositionClosed(positionId, feesClaimedSol, `${reason}_external`, position)
      await sendCloseAlert(position, feesClaimedSol, reason)
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

    await markPositionClosed(positionId, feesClaimedSol, reason, position)
    await sendCloseAlert(position, feesClaimedSol, reason)
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

async function sendCloseAlert(position: any, feesClaimedSol: number, reason: string): Promise<void> {
  try {
    const openedAt  = position.opened_at ? new Date(position.opened_at).getTime() : Date.now()
    const ageHours  = parseFloat(((Date.now() - openedAt) / 3_600_000).toFixed(1))

    await sendAlert({
      type:          'position_closed',
      symbol:        position.symbol,
      strategy:      position.metadata?.strategy_id ?? 'unknown',
      reason,
      feesEarnedSol: parseFloat(feesClaimedSol.toFixed(6)),
      ilPct:         0,
      ageHours,
      netPnlSol:     feesClaimedSol,
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
      fees_earned_sol: 0,
      status:          needsLiquidityRetry ? 'pending_retry' : 'active',
      in_range:        true,
      dry_run:         dryRun,
      opened_at:       new Date().toISOString(),
      tx_open:         sig,
      metadata: {
        strategy_id:           strategy.id,
        bin_range_down:        strategy.position.rangeDownPct,
        bin_range_up:          strategy.position.rangeUpPct,
        needs_liquidity_retry: needsLiquidityRetry,
      },
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to persist LP position: ${error.message}`)
  return data.id
}

/**
 * Marks a DLMM position closed and writes realized_pnl_usd.
 * realized_pnl_usd = fees_earned_sol converted to USD at close-time SOL price.
 * We use entry_price_usd / entry_price_sol as the SOL/USD rate since we have
 * no live price oracle here; this approximates within normal hold durations.
 */
async function markPositionClosed(
  positionId: string,
  feesEarnedSol: number,
  reason: string,
  position?: Record<string, any>
): Promise<void> {
  const supabase = createServerClient()

  let realizedPnlUsd: number | null = null
  if (position) {
    const entryPriceSol: number = position.entry_price_sol ?? 0
    const entryPriceUsd: number = position.entry_price_usd ?? 0
    const solPriceUsd = entryPriceSol > 0 ? entryPriceUsd / entryPriceSol : 0
    if (solPriceUsd > 0) {
      realizedPnlUsd = Math.round(feesEarnedSol * solPriceUsd * 100) / 100
    }
  }

  await supabase
    .from('lp_positions')
    .update({
      status:            'closed',
      closed_at:         new Date().toISOString(),
      fees_earned_sol:   feesEarnedSol,
      oor_since_at:      null,
      close_reason:      reason,
      ...(realizedPnlUsd !== null ? { realized_pnl_usd: realizedPnlUsd } : {}),
    })
    .eq('id', positionId)
}
