import DLMM, { StrategyType } from '@meteora-ag/dlmm'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import type { Strategy, TokenMetrics } from '@/lib/types'

const DRY_RUN = process.env.BOT_DRY_RUN === 'true'

// Meteora-specific cost constants (in SOL)
// Position account rent:  ~0.057 SOL (refunded on close)
// Bin array rent:         ~0.024 SOL for ~15 arrays (refunded on close)
// Priority fee + tx fee:  ~0.005 SOL (not refunded)
// Safety buffer:          ~0.014 SOL
const METEORA_RENT_RESERVE_SOL = 0.1

async function sendLegacyTx(
  tx: Transaction,
  signers: import('@solana/web3.js').Signer[]
): Promise<string> {
  const connection = getConnection()
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

export async function openPosition(
  metrics: TokenMetrics,
  strategy: Strategy
): Promise<string | null> {
  const label = `[executor][${strategy.id}][${metrics.symbol}]`
  console.log(`${label} opening position`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — skipping on-chain tx`)
    return await persistPosition(metrics, strategy, 'dry-run-sig', 0, 0)
  }

  const connection = getConnection()
  const wallet = getWallet()
  const supabase = createServerClient()

  try {
    // 1. Calculate SOL amount and check balance first
    const maxSol = parseFloat(process.env.MAX_SOL_PER_POSITION ?? '0.1')
    const solAmount = Math.min(strategy.position.maxSolPerPosition, maxSol)
    const requiredLamports = Math.floor((solAmount + METEORA_RENT_RESERVE_SOL) * 1e9)

    const balanceLamports = await connection.getBalance(wallet.publicKey)
    const balanceSol = balanceLamports / 1e9
    console.log(`${label} wallet balance: ${balanceSol.toFixed(4)} SOL`)

    if (balanceLamports < requiredLamports) {
      console.warn(
        `${label} insufficient balance — need ${(solAmount + METEORA_RENT_RESERVE_SOL).toFixed(3)} SOL, have ${balanceSol.toFixed(4)} SOL`
      )
      await supabase.from('bot_logs').insert({
        level: 'warn', event: 'open_position_skipped_insufficient_balance',
        payload: { symbol: metrics.symbol, balanceSol, requiredSol: solAmount + METEORA_RENT_RESERVE_SOL },
      })
      return null
    }

    // 2. Load DLMM pool
    const dlmmPool = await DLMM.create(connection, new PublicKey(metrics.poolAddress))
    const activeBin = await dlmmPool.getActiveBin()
    const activeBinId = activeBin.binId

    // 3. Calculate bin range
    const binStep = dlmmPool.lbPair.binStep
    const binsDown = Math.abs(Math.round((strategy.position.rangeDownPct / 100) / (binStep / 10_000)))
    const binsUp = Math.round((strategy.position.rangeUpPct / 100) / (binStep / 10_000))
    const minBinId = activeBinId - binsDown
    const maxBinId = activeBinId + binsUp
    console.log(`${label} bin range: ${minBinId} → ${maxBinId} (${binsDown + binsUp} bins, step=${binStep})`)

    // 4. Map strategy distribution type
    const strategyTypeMap: Record<string, StrategyType> = {
      spot: StrategyType.Spot,
      curve: StrategyType.Curve,
      'bid-ask': StrategyType.BidAsk,
    }
    const strategyType = strategyTypeMap[strategy.position.distributionType] ?? StrategyType.Spot

    // 5. Get priority fee
    const priorityFee = await getPriorityFee([metrics.poolAddress, wallet.publicKey.toBase58()])
    console.log(`${label} priority fee: ${priorityFee} microlamports`)

    // 6. STEP 1 — Initialize position account (separate tx to avoid InvalidRealloc)
    const positionKeypair = new Keypair()
    const initTx = await dlmmPool.initializePosition({
      payer: wallet.publicKey,
      lowerBinId: minBinId,
      positionWidth: binsDown + binsUp,
      owner: wallet.publicKey,
      positionPubKey: positionKeypair.publicKey,
    })
    console.log(`${label} tx 1/2 — initializing position account`)
    const initSig = await sendLegacyTx(initTx, [wallet, positionKeypair])
    console.log(`${label} tx 1/2 confirmed ✔ sig: ${initSig}`)

    // 7. STEP 2 — Add liquidity (separate tx, no realloc issue)
    const lamports = Math.floor(solAmount * 1e9)
    const totalX = new BN(Math.floor(lamports * (1 - strategy.position.solBias)))
    const totalY = new BN(Math.floor(lamports * strategy.position.solBias))

    const addLiqTxOrTxs = await dlmmPool.addLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalX,
      totalYAmount: totalY,
      strategy: { maxBinId, minBinId, strategyType },
    })

    const addLiqTxs = Array.isArray(addLiqTxOrTxs) ? addLiqTxOrTxs : [addLiqTxOrTxs]
    console.log(`${label} tx 2/2 — adding liquidity (${addLiqTxs.length} tx(s))`)
    let lastSig = initSig
    for (let i = 0; i < addLiqTxs.length; i++) {
      lastSig = await sendLegacyTx(addLiqTxs[i], [wallet])
      console.log(`${label} tx 2.${i + 1}/${addLiqTxs.length} confirmed ✔ sig: ${lastSig}`)
    }

    console.log(`${label} position opened ✔`)
    return await persistPosition(
      metrics, strategy, lastSig,
      metrics.priceUsd, solAmount,
      positionKeypair.publicKey.toBase58()
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
    .from('positions')
    .select('*')
    .eq('id', positionId)
    .single()

  if (error || !position) {
    console.error(`[executor] closePosition: position ${positionId} not found`)
    return false
  }

  const label = `[executor][close][${position.token_symbol}]`
  console.log(`${label} closing — reason: ${reason}`)

  if (DRY_RUN) {
    console.log(`${label} DRY RUN — marking closed without on-chain tx`)
    await markPositionClosed(positionId, 0, reason)
    return true
  }

  const connection = getConnection()
  const wallet = getWallet()

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(position.pool_address))
    const positionPubKey = new PublicKey(position.metadata?.positionPubKey ?? '')

    // 1. Claim fees
    let feesClaimedSol = 0
    try {
      const claimTxs = await dlmmPool.claimAllRewards({
        owner: wallet.publicKey,
        positions: [{ publicKey: positionPubKey } as never],
      })
      for (const tx of Array.isArray(claimTxs) ? claimTxs : [claimTxs]) {
        const claimSig = await sendLegacyTx(tx, [wallet])
        console.log(`${label} fees claimed ✔ sig: ${claimSig}`)
      }
      feesClaimedSol = position.fees_earned_sol ?? 0
    } catch (err) {
      console.warn(`${label} fee claim failed (continuing with close):`, err)
    }

    // 2. Remove all liquidity
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const userPosition = userPositions.find(
      (p) => p.publicKey.toBase58() === positionPubKey.toBase58()
    )

    if (userPosition) {
      const { lowerBinId, upperBinId } = userPosition.positionData
      const removeTx = await dlmmPool.removeLiquidity({
        position: positionPubKey,
        user: wallet.publicKey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      })
      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        const sig = await sendLegacyTx(tx, [wallet])
        console.log(`${label} liquidity removed ✔ sig: ${sig}`)
      }
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
  entryPrice: number,
  solDeposited: number,
  positionPubKey?: string
): Promise<string> {
  const supabase = createServerClient()
  const { data, error } = await supabase
    .from('positions')
    .insert({
      token_symbol: metrics.symbol,
      token_address: metrics.address,
      pool_address: metrics.poolAddress,
      strategy_id: strategy.id,
      bin_range_lower: entryPrice * (1 + strategy.position.rangeDownPct / 100),
      bin_range_upper: entryPrice * (1 + strategy.position.rangeUpPct / 100),
      entry_price: entryPrice,
      sol_deposited: solDeposited,
      fees_earned_sol: 0,
      status: 'active',
      in_range: true,
      opened_at: new Date().toISOString(),
      metadata: { sig, positionPubKey },
    })
    .select('id')
    .single()
  if (error) throw new Error(`Failed to persist position: ${error.message}`)
  return data.id
}

async function markPositionClosed(
  positionId: string,
  feesEarnedSol: number,
  reason: string
): Promise<void> {
  const supabase = createServerClient()
  await supabase
    .from('positions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      fees_earned_sol: feesEarnedSol,
      metadata: { closeReason: reason },
    })
    .eq('id', positionId)
}
