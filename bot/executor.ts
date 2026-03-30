import DLMM, { StrategyType } from '@meteora-ag/dlmm'
import { Keypair, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { getConnection, getWallet, getPriorityFee } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import type { Strategy, TokenMetrics } from '@/lib/types'

const DRY_RUN = process.env.BOT_DRY_RUN === 'true'

// ---------------------------------------------------------------------------
// Open a new DLMM position
// ---------------------------------------------------------------------------

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
    // 1. Load the DLMM pool
    const dlmmPool = await DLMM.create(connection, new PublicKey(metrics.poolAddress))

    // 2. Verify pool price is in sync (anti-arb check)
    const activeBin = await dlmmPool.getActiveBin()
    const poolPriceUsd = parseFloat(activeBin.pricePerToken)
    const priceDriftPct = Math.abs((poolPriceUsd - metrics.priceUsd) / metrics.priceUsd) * 100

    if (priceDriftPct > 2) {
      console.warn(`${label} pool price drifted ${priceDriftPct.toFixed(2)}% from market — skipping`)
      await supabase.from('bot_logs').insert({
        level: 'warn',
        event: 'position_skipped_price_drift',
        payload: { symbol: metrics.symbol, priceDriftPct },
      })
      return null
    }

    // 3. Calculate bin range from strategy config
    const activeBinId = activeBin.binId
    const binStep = dlmmPool.lbPair.binStep
    const binsDown = Math.abs(
      Math.round((strategy.position.rangeDownPct / 100) / (binStep / 10_000))
    )
    const binsUp = Math.round(
      (strategy.position.rangeUpPct / 100) / (binStep / 10_000)
    )
    const minBinId = activeBinId - binsDown
    const maxBinId = activeBinId + binsUp

    // 4. Calculate SOL amount
    const maxSol = parseFloat(process.env.MAX_SOL_PER_POSITION ?? '0.5')
    const solAmount = Math.min(strategy.position.maxSolPerPosition, maxSol)
    const lamports = Math.floor(solAmount * 1e9)

    // Split between X (token) and Y (SOL/quote) based on solBias
    const totalX = new BN(Math.floor(lamports * (1 - strategy.position.solBias)))
    const totalY = new BN(Math.floor(lamports * strategy.position.solBias))

    // 5. Map strategy distribution type
    const strategyTypeMap: Record<string, StrategyType> = {
      spot: StrategyType.Spot,
      curve: StrategyType.Curve,
      'bid-ask': StrategyType.BidAsk,
    }
    const strategyType = strategyTypeMap[strategy.position.distributionType] ?? StrategyType.Spot

    // 6. Get priority fee
    const priorityFee = await getPriorityFee([
      metrics.poolAddress,
      wallet.publicKey.toBase58(),
    ])

    // 7. Generate position keypair and build position transaction
    const positionKeypair = new Keypair()
    const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: positionKeypair.publicKey,
      user: wallet.publicKey,
      totalXAmount: totalX,
      totalYAmount: totalY,
      strategy: {
        maxBinId,
        minBinId,
        strategyType,
      },
    })

    // 8. Send transaction
    tx.sign([wallet, positionKeypair])
    const sig = await connection.sendTransaction(tx, { maxRetries: 3 })
    await connection.confirmTransaction(sig, 'confirmed')

    console.log(`${label} position opened ✔ sig: ${sig}`)

    // 9. Persist to Supabase
    return await persistPosition(
      metrics,
      strategy,
      sig,
      poolPriceUsd,
      solAmount,
      positionKeypair.publicKey.toBase58()
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'open_position_failed',
      payload: { symbol: metrics.symbol, strategy: strategy.id, error: message },
    })
    return null
  }
}

// ---------------------------------------------------------------------------
// Close a position (claim fees + remove liquidity)
// ---------------------------------------------------------------------------

export async function closePosition(
  positionId: string,
  reason: string
): Promise<boolean> {
  const supabase = createServerClient()

  // Fetch position from DB
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

    // 1. Claim all fees first (if strategy says to)
    let feesClaimedSol = 0
    if (position.strategy_id) {
      try {
        const claimTx = await dlmmPool.claimAllRewards({
          owner: wallet.publicKey,
          positions: [{ publicKey: positionPubKey } as never],
        })
        const claimSig = await connection.sendTransaction(claimTx, { maxRetries: 3 })
        await connection.confirmTransaction(claimSig, 'confirmed')
        console.log(`${label} fees claimed ✔ sig: ${claimSig}`)
        // TODO: parse actual fee amounts from tx logs
        feesClaimedSol = position.fees_earned_sol ?? 0
      } catch (err) {
        console.warn(`${label} fee claim failed (continuing with close):`, err)
      }
    }

    // 2. Remove all liquidity
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(
      wallet.publicKey
    )
    const userPosition = userPositions.find(
      (p) => p.publicKey.toBase58() === positionPubKey.toBase58()
    )

    if (userPosition) {
      const binIdsToRemove = userPosition.positionData.positionBinData.map(
        (b: { binId: number }) => b.binId
      )
      const removeTx = await dlmmPool.removeLiquidity({
        position: positionPubKey,
        user: wallet.publicKey,
        binIds: binIdsToRemove,
        liquiditiesBpsToRemove: binIdsToRemove.map(() => new BN(10_000)), // 100%
        shouldClaimAndClose: true,
      })

      for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
        tx.sign([wallet])
        const sig = await connection.sendTransaction(tx, { maxRetries: 3 })
        await connection.confirmTransaction(sig, 'confirmed')
        console.log(`${label} liquidity removed ✔ sig: ${sig}`)
      }
    }

    await markPositionClosed(positionId, feesClaimedSol, reason)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`${label} close failed:`, message)
    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'close_position_failed',
      payload: { positionId, reason, error: message },
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      metadata: supabase.rpc ? undefined : { closeReason: reason }, // merge in monitor
    })
    .eq('id', positionId)
}
