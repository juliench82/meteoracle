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

// Env-level kill switch: if BOT_DRY_RUN=true in env, always dry regardless of DB state.
// If unset or 'false', defer to botState.dry_run (toggled by /dry and /live).
const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

const METEORA_RENT_RESERVE_SOL = 0.07
const NATIVE_MINT_STR = NATIVE_MINT.toBase58()

const MAX_SOL_PER_POSITION     = parseFloat(process.env.MAX_SOL_PER_POSITION     ?? '0.05')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS   ?? '5')
const WALLET_RESERVE_MULTIPLIER = parseFloat(process.env.WALLET_RESERVE_MULTIPLIER ?? '1.5')

const COMPUTE_BUDGET_PROGRAM_ID = ComputeBudgetProgram.programId.toBase58()

/**
 * Maximum bin range per strategy — prevents OOM in simulation for wide positions.
 */
const MAX_BINS_BY_STRATEGY: Record<string, number> = {
  'evil-panda':    200,
  'scalp-spike':   120,
  'bluechip-farm': 100,
  'stable-farm':   100,
}
const MAX_BINS_DEFAULT = 150

/** Shared strategy params shape used by addLiquidityWithRetry. */
interface LiquidityStrategyParams {
  minBinId: number
  maxBinId: number
  strategyType: StrategyType
}

/**
 * Transient error messages emitted by the DLMM program / on-chain runtime.
 * Retriable with backoff.
 */
function isTransientLiquidityError(msg: string): boolean {
  return (
    msg.includes('Assertion failed') ||
    msg.includes('index out of bounds') ||
    msg.includes('ProgramFailedToComplete') ||
    msg.includes('memory allocation failed') ||
    msg.includes('out of memory')
  )
}

/**
 * Strip any ComputeBudget instructions already present in an ix array.
 * Prevents 'duplicate instruction' simulation failure when we prepend our own.
 */
function stripComputeBudgetIxs(ixs: TransactionInstruction[]): TransactionInstruction[] {
  return ixs.filter(ix => ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID)
}

function toIxArray(ix: TransactionInstruction | TransactionInstruction[]): TransactionInstruction[] {
  return Array.isArray(ix) ? ix : [ix]
}

/**
 * Simulate a transaction before sending.
 * Returns false if simulation definitively reported a program error OR OOM.
 */
async function simulateAndCheck(
  tx: Transaction,
  label: string
): Promise<boolean> {
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
    console.log(`${label} simulation OK (units consumed: ${sim.value.unitsConsumed ?? 'n/a'})`)
    return true
  } catch (simErr: unknown) {
    const msg = simErr instanceof Error ? simErr.message : String(simErr)
    if (msg.includes('memory allocation failed') || msg.includes('out of memory')) {
      console.error(`${label} ⚠ simulation OOM — position too large, aborting send`, { error: msg })
      return false
    }
    console.warn(`${label} simulation call threw — proceeding anyway:`, simErr)
    return true
  }
}

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
  if (!simOk) {
    throw new Error(`${label} transaction aborted — simulation reported program error`)
  }

  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
  const connection = getConnection()
  const info = await connection.getAccountInfo(mint)
  if (info && info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID
  return TOKEN_PROGRAM_ID
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDecimalAdjustedPrice(dlmmPool: any, activeBin: { price: string; pricePerToken: string }): number {
  try {
    const adjusted = dlmmPool.fromPricePerLamport(Number(activeBin.price))
    const price = parseFloat(adjusted)
    if (isFinite(price) && price > 0) return price
  } catch {}
  return parseFloat(activeBin.pricePerToken)
}

/**
 * Wait for a position account to be owned by DLMM AND have its bin arrays populated.
 * After confirmation, adds a mandatory 2.5s propagation delay.
 */
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
        console.log(`${label} [wait] position account confirmed ready on-chain (attempt ${i}/${maxAttempts})`)
        console.log(`${label} [wait] extra 2.5s propagation delay…`)
        await new Promise(r => setTimeout(r, 2500))
        return
      }
    } catch {
      // getPositionsByUserAndLbPair can throw transiently — retry
    }

    console.log(`${label} [wait] account owned but DLMM state not yet ready… attempt ${i}/${maxAttempts}`)
    await new Promise(r => setTimeout(r, intervalMs))
  }

  console.warn(`${label} [wait] readiness not confirmed after ${maxAttempts} attempts — adding 5s safety delay`)
  await new Promise(r => setTimeout(r, 5000))
}

/**
 * Call addLiquidityByStrategy with exponential backoff on transient DLMM errors.
 * Delays: attempt 1 = 3s, attempt 2 = 6s, attempt 3 = 12s.
 */
async function addLiquidityWithRetry(
  dlmmPool: Awaited<ReturnType<Awaited<ReturnType<typeof getDLMM>>['create']>>,
  params: {
    positionPubKey: PublicKey
    user: PublicKey
    totalXAmount: BN
    totalYAmount: BN
    strategy: LiquidityStrategyParams
  },
  label: string,
  maxRetries = 3
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`${label} [addLiquidity] attempt ${attempt}/${maxRetries}`)
      return await dlmmPool.addLiquidityByStrategy(params)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!isTransientLiquidityError(msg) || attempt === maxRetries) throw err

      const delayMs = 3000 * Math.pow(2, attempt - 1) // 3s → 6s → 12s
      console.warn(
        `${label} [addLiquidity] transient error on attempt ${attempt}/${maxRetries} — retrying in ${delayMs}ms`,
        { positionPubKey: params.positionPubKey.toBase58(), error: msg }
      )
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
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
    console.log(`${label} DRY RUN — skipping on-chain tx (env_forced=${ENV_DRY_RUN_FORCED}, botState=${botState.dry_run})`)
    const envCap = parseFloat(process.env.MAX_SOL_PER_POSITION ?? '0.05')
    const dryRunSolAmount = strategy.position.maxSolPerPosition
      ? Math.min(strategy.position.maxSolPerPosition, envCap)
      : envCap
    return await persistPosition(
      metrics, strategy, 'dry-run-sig',
      metrics.priceUsd ?? 0, 0, dryRunSolAmount, undefined, 0
    )
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
      console.warn(`${label} global exposure cap hit — ${totalDeployed.toFixed(3)} SOL deployed (limit ${maxTotalDeployed})`)
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
        console.warn(`${label} token in cooldown — closed within last ${cooldownHours}h (reason: ${lastClose[0].close_reason})`)
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
      console.warn(
        `${label} insufficient balance — need ${requiredSol.toFixed(3)} SOL ` +
        `(position=${solAmount} + rent=${METEORA_RENT_RESERVE_SOL} + reserve=${dynamicReserve.toFixed(3)} ` +
        `[${remainingSlots} slots × ${MAX_SOL_PER_POSITION} × ${WALLET_RESERVE_MULTIPLIER}]), ` +
        `have ${balanceSol.toFixed(4)} SOL`
      )
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_insufficient_balance',
        payload: { symbol: metrics.symbol, balanceSol, requiredSol, dynamicReserve, remainingSlots },
      })
      return null
    }

    const DLMM = await getDLMM()
    const dlmmPool = await DLMM.create(connection, new PublicKey(metrics.poolAddress))
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId

    const entryPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin)
    console.log(`${label} entry price: ${entryPriceSol.toFixed(9)} SOL/token (bin ${activeBinId})`)

    const binStep = dlmmPool.lbPair.binStep
    const mintX   = dlmmPool.tokenX.publicKey
    const mintY   = dlmmPool.tokenY.publicKey
    const isSolPool = mintY.toBase58() === NATIVE_MINT_STR

    const ataIxs: TransactionInstruction[] = []
    for (const [label_token, mint] of [['X', mintX], ['Y', mintY]] as [string, PublicKey][]) {
      if (mint.toBase58() === NATIVE_MINT_STR) {
        console.log(`${label} token ${label_token} is native SOL — skipping ATA`)
        continue
      }
      const tokenProgramId = await getTokenProgramId(mint)
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID)
      if (!(await connection.getAccountInfo(ata))) {
        console.log(`${label} creating ATA for token ${label_token} (${mint.toBase58().slice(0, 8)}…)`)
        ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, ata, wallet.publicKey, mint, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID
        ))
      }
    }
    if (ataIxs.length > 0) {
      const ataTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        ...ataIxs
      )
      const ataSig = await sendLegacyTx(ataTx, [wallet], label)
      console.log(`${label} ATA(s) created ✔ sig: ${ataSig}`)
    }

    const binsDown = Math.abs(Math.round((strategy.position.rangeDownPct / 100) / (binStep / 10_000)))
    const binsUp   = Math.round((strategy.position.rangeUpPct / 100) / (binStep / 10_000))
    const minBinId  = activeBinId - binsDown
    const maxBinId  = activeBinId + binsUp
    const binRange  = binsDown + binsUp

    const maxBins = MAX_BINS_BY_STRATEGY[strategy.id] ?? MAX_BINS_DEFAULT
    if (binRange > maxBins) {
      console.warn(`${label} bin range too wide — rejecting candidate`, { mint: metrics.address, binRange, maxBins, binStep })
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_bin_range_cap',
        payload: { symbol: metrics.symbol, strategy: strategy.id, binRange, maxBins, binStep },
      })
      return null
    }

    console.log(`${label} bin range: ${minBinId} → ${maxBinId} (${binRange} bins, step=${binStep})`)

    const lamports = Math.floor(solAmount * 1e9)
    let totalX: BN
    let totalY: BN
    if (isSolPool) {
      totalX = new BN(0)
      totalY = new BN(lamports)
      console.log(`${label} one-sided SOL deposit: totalX=0, totalY=${lamports} lamports`)
    } else {
      totalX = new BN(Math.floor(lamports * (1 - strategy.position.solBias)))
      totalY = new BN(Math.floor(lamports * strategy.position.solBias))
    }

    const StrategyTypeEnum = await getStrategyType()
    const strategyTypeMap: Record<string, StrategyType> = {
      spot:     StrategyTypeEnum.Spot,
      curve:    StrategyTypeEnum.Curve,
      'bid-ask': StrategyTypeEnum.BidAsk,
    }
    const strategyType: StrategyType = strategyTypeMap[strategy.position.distributionType] ?? StrategyTypeEnum.Spot

    const priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

    const keypairFactory = async (count: number): Promise<Keypair[]> =>
      Array.from({ length: count }, () => new Keypair())

    const response = await dlmmPool.initializeMultiplePositionAndAddLiquidityByStrategy(
      keypairFactory,
      totalX,
      totalY,
      { minBinId, maxBinId, strategyType },
      wallet.publicKey,
      wallet.publicKey,
      1
    )

    let lastSig = ''
    let posIndex = 0
    const total = response.instructionsByPositions.length
    console.log(`${label} opening ${total} position segment(s)`)

    let positionKeypairForQuery: Keypair | null = null

    // Typed strategy params shared between atomic and two-step paths
    const liqStrategyParams: LiquidityStrategyParams = { minBinId, maxBinId, strategyType }

    for (const { positionKeypair, initializePositionIx } of response.instructionsByPositions) {
      if (!positionKeypairForQuery) positionKeypairForQuery = positionKeypair
      posIndex++

      console.log(`${label} preparing position segment ${posIndex}/${total}`, {
        mint: metrics.address,
        strategy: strategy.id,
        binRange: `${minBinId} → ${maxBinId} (${binRange} bins)`,
        binStep,
      })

      // ── ATOMIC PATH (preferred — eliminates race condition entirely) ──
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dlmmPoolAny = dlmmPool as any
      const hasAtomic = typeof dlmmPoolAny.initializePositionAndAddLiquidityByStrategy === 'function'

      if (hasAtomic) {
        console.log(`${label} [atomic] using initializePositionAndAddLiquidityByStrategy`)
        try {
          // Wrap atomic call in the retry helper — transient errors still get retried.
          // We can't pass the atomic call directly to addLiquidityWithRetry (different signature),
          // so we inline the retry logic here with the same backoff curve.
          let atomicResult: unknown
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              console.log(`${label} [atomic] attempt ${attempt}/3`)
              atomicResult = await dlmmPoolAny.initializePositionAndAddLiquidityByStrategy({
                positionPubKey: positionKeypair.publicKey,
                user:           wallet.publicKey,
                totalXAmount:   totalX,
                totalYAmount:   totalY,
                strategy:       liqStrategyParams,
              })
              break
            } catch (aErr: unknown) {
              const aMsg = aErr instanceof Error ? aErr.message : String(aErr)
              if (!isTransientLiquidityError(aMsg) || attempt === 3) throw aErr
              const delay = 3000 * Math.pow(2, attempt - 1)
              console.warn(`${label} [atomic] transient error attempt ${attempt}/3 — retrying in ${delay}ms`, { error: aMsg })
              await new Promise(r => setTimeout(r, delay))
            }
          }

          const rawIxs  = toIxArray(atomicResult as TransactionInstruction | TransactionInstruction[])
          const cleanIxs = stripComputeBudgetIxs(rawIxs)
          const atomicTx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
            ...cleanIxs
          )
          lastSig = await sendLegacyTx(atomicTx, [wallet, positionKeypair], label)
          console.log(`${label} [atomic] seg ${posIndex}/${total} confirmed ✔ sig: ${lastSig}`)
          continue
        } catch (atomicErr: unknown) {
          const atomicMsg = atomicErr instanceof Error ? atomicErr.message : String(atomicErr)
          console.warn(`${label} [atomic] failed — falling back to two-step`, { error: atomicMsg })
        }
      }

      // ── TWO-STEP PATH (fallback) ──
      const rawInitIxs = toIxArray(initializePositionIx as TransactionInstruction | TransactionInstruction[])
      const initIxs    = stripComputeBudgetIxs(rawInitIxs)
      const initTx     = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
        ...initIxs
      )
      console.log(`${label} [two-step] sending init tx for segment ${posIndex}/${total}`)
      lastSig = await sendLegacyTx(initTx, [wallet, positionKeypair], label)
      console.log(`${label} [two-step] seg ${posIndex}/${total} init confirmed ✔ sig: ${lastSig}`)

      await waitForPositionAccountReady(dlmmPool, positionKeypair.publicKey, wallet.publicKey, label)

      try {
        const liqResponse = await addLiquidityWithRetry(
          dlmmPool,
          {
            positionPubKey: positionKeypair.publicKey,
            user:           wallet.publicKey,
            totalXAmount:   totalX,
            totalYAmount:   totalY,
            strategy:       liqStrategyParams,
          },
          label
        )

        const rawLiqIxs = toIxArray(liqResponse as unknown as TransactionInstruction | TransactionInstruction[])
        const liqIxs    = stripComputeBudgetIxs(rawLiqIxs)
        const liqTx     = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          ...liqIxs
        )
        lastSig = await sendLegacyTx(liqTx, [wallet], label)
        console.log(`${label} [two-step] seg ${posIndex}/${total} liq confirmed ✔ sig: ${lastSig}`)
      } catch (liqErr: unknown) {
        const liqMsg = liqErr instanceof Error ? liqErr.message : String(liqErr)
        console.error(
          `${label} [two-step] seg ${posIndex}/${total} addLiquidity permanently failed — persisting as needs_liquidity_retry`,
          { error: liqMsg }
        )
        await supabase.from('bot_logs').insert({
          level: 'error', event: 'add_liquidity_failed_all_retries',
          payload: {
            symbol:          metrics.symbol,
            strategy:        strategy.id,
            positionPubkey:  positionKeypair.publicKey.toBase58(),
            initSig:         lastSig,
            error:           liqMsg,
          },
        })
        return await persistPosition(
          metrics, strategy, lastSig,
          metrics.priceUsd ?? 0, entryPriceSol, solAmount,
          positionKeypair.publicKey.toBase58(), 0, true
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
          console.log(`${label} token amount in position: ${tokenAmountDeposited.toFixed(4)}`)
        }
      } catch (err) {
        console.warn(`${label} could not fetch token amount from on-chain position:`, err)
      }
    }

    console.log(`${label} position opened ✔`)
    const firstPubKey = response.instructionsByPositions[0]?.positionKeypair?.publicKey?.toBase58()
    return await persistPosition(
      metrics, strategy, lastSig,
      metrics.priceUsd ?? 0, entryPriceSol, solAmount,
      firstPubKey, tokenAmountDeposited
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
    .from('lp_positions')
    .select('*')
    .eq('id', positionId)
    .single()

  if (error || !position) {
    console.error(`[executor] closePosition: LP position ${positionId} not found`)
    return false
  }

  const label = `[executor][close][${position.symbol}]`
  console.log(`${label} closing — reason: ${reason}`)

  const connection = getConnection()
  const wallet     = getWallet()

  try {
    const DLMM = await getDLMM()
    const dlmmPool      = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubKey = new PublicKey(position.position_pubkey ?? '')

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

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const userPosition = userPositions.find(p => p.publicKey.toBase58() === positionPubKey.toBase58())

    if (userPosition) {
      const { lowerBinId, upperBinId } = userPosition.positionData
      const removeTx = await dlmmPool.removeLiquidity({
        position:           positionPubKey,
        user:               wallet.publicKey,
        fromBinId:          lowerBinId,
        toBinId:            upperBinId,
        bps:                new BN(10_000),
        shouldClaimAndClose: true,
      })
      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendLegacyTx(tx, [wallet], label)
        console.log(`${label} liquidity removed ✔ sig: ${sig}`)
      }
    } else {
      console.warn(`${label} position not found on-chain — marking closed in DB`)
      await markPositionClosed(positionId, feesClaimedSol, `${reason}_external`)
      return true
    }

    try {
      await swapTokenToSol(position.mint, label)
    } catch (err) {
      console.warn(`${label} token→SOL swap failed (continuing):`, err)
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'swap_token_to_sol_failed',
        payload: { positionId, mint: position.mint, reason, error: err instanceof Error ? err.message : String(err) },
      })
    }

    await markPositionClosed(positionId, feesClaimedSol, reason)
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

async function persistPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
  sig: string,
  entryPriceUsd: number,
  entryPriceSol: number,
  solDeposited: number,
  positionPubKey?: string,
  tokenAmount: number = 0,
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
      dry_run:         ENV_DRY_RUN_FORCED,
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

async function markPositionClosed(
  positionId: string,
  feesEarnedSol: number,
  reason: string
): Promise<void> {
  const supabase = createServerClient()
  await supabase
    .from('lp_positions')
    .update({
      status:          'closed',
      closed_at:       new Date().toISOString(),
      fees_earned_sol: feesEarnedSol,
      oor_since_at:    null,
      close_reason:    reason,
    })
    .eq('id', positionId)
}
