import DLMM from '@meteora-ag/dlmm'
import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { closePosition, openPosition } from '@/bot/executor'
import { sendAlert } from '@/bot/alerter'
import { STRATEGIES } from '@/strategies'
import type { Strategy } from '@/lib/types'

const SUPABASE_TIMEOUT_MS = 5_000
// Smart rebalance: trigger if price has moved more than this % within the active range
const SMART_REBALANCE_THRESHOLD_PCT = 30
// Minimum volume (USD/h) to justify a rebalance reopen — avoids churning dead pools
const MIN_VOLUME_USD_FOR_REBALANCE = 500

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T | null> {
  const timer = new Promise<null>((resolve) =>
    setTimeout(() => { console.warn(`[monitor] timeout (${ms}ms): ${label}`); resolve(null) }, ms)
  )
  return Promise.race([Promise.resolve(promise), timer])
}

export async function monitorPositions(): Promise<{
  checked: number
  closed: number
  claimed: number
  rebalanced: number
}> {
  const supabase = createServerClient()
  const stats = { checked: 0, closed: 0, claimed: 0, rebalanced: 0 }

  console.log('[monitor] fetching open positions')
  const result = await withTimeout(
    supabase.from('positions').select('*').in('status', ['active', 'out_of_range']),
    SUPABASE_TIMEOUT_MS,
    'positions select'
  )

  if (!result) {
    console.warn('[monitor] Supabase timed out — skipping monitor this tick')
    return stats
  }

  const { data: positions, error } = result
  if (error) { console.warn('[monitor] positions fetch error:', error.message); return stats }
  if (!positions?.length) { console.log('[monitor] no open positions'); return stats }

  console.log(`[monitor] checking ${positions.length} positions`)

  for (const position of positions) {
    try {
      stats.checked++
      const strategy = STRATEGIES.find((s) => s.id === position.strategy_id)
      if (!strategy) continue
      await checkPosition(position, strategy, stats)
    } catch (err) {
      console.error(`[monitor] error checking position ${position.id}:`, err)
      await withTimeout(
        supabase.from('bot_logs').insert({
          level: 'error', event: 'monitor_check_failed',
          payload: { positionId: position.id, error: String(err) },
        }),
        SUPABASE_TIMEOUT_MS, 'bot_logs insert'
      )
    }
  }

  return stats
}

async function checkPosition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  position: Record<string, any>,
  strategy: Strategy,
  stats: { checked: number; closed: number; claimed: number; rebalanced: number }
): Promise<void> {
  const supabase = createServerClient()
  const label = `[monitor][${position.token_symbol}][${strategy.id}]`
  const now = Date.now()

  const { inRange, currentPrice, feesEarnedSol, volume1hUsd } = await fetchPositionState(
    position.pool_address,
    position.metadata?.positionPubKey
  )

  // Impermanent loss (%):
  const entryPrice = position.entry_price ?? 0
  const k = entryPrice > 0 ? currentPrice / entryPrice : 1
  const ilPct = entryPrice > 0
    ? Math.round((2 * Math.sqrt(k) / (1 + k) - 1) * 10000) / 100
    : 0

  await withTimeout(
    supabase.from('positions').update({
      current_price: currentPrice,
      in_range: inRange,
      fees_earned_sol: feesEarnedSol,
      il_pct: ilPct,
      status: inRange ? 'active' : 'out_of_range',
    }).eq('id', position.id),
    SUPABASE_TIMEOUT_MS, 'positions update'
  )

  const openedAt   = new Date(position.opened_at).getTime()
  const ageHours   = (now - openedAt) / (1000 * 60 * 60)
  const pricePct   = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0
  const oorSince   = position.status === 'out_of_range'
    ? (now - new Date(position.updated_at ?? position.opened_at).getTime()) / 60_000
    : 0

  // --- Hard exits ---
  let closeReason: string | null = null
  if (!inRange && oorSince >= strategy.exits.outOfRangeMinutes) closeReason = `out_of_range_${Math.round(oorSince)}min`
  else if (pricePct <= strategy.exits.stopLossPct)              closeReason = `stop_loss_${pricePct.toFixed(1)}pct`
  else if (pricePct >= strategy.exits.takeProfitPct)            closeReason = `take_profit_${pricePct.toFixed(1)}pct`
  else if (ageHours >= strategy.exits.maxDurationHours)         closeReason = `max_duration_${Math.round(ageHours)}h`

  if (closeReason) {
    console.log(`${label} EXIT triggered → ${closeReason}`)
    const closed = await closePosition(position.id, closeReason)
    if (closed) {
      stats.closed++
      await sendAlert({
        type: 'position_closed',
        symbol: position.token_symbol,
        strategy: strategy.id,
        reason: closeReason,
        feesEarnedSol,
        ilPct,
        ageHours: Math.round(ageHours * 10) / 10,
      })
    }
    return
  }

  // --- Smart rebalance: price drifted >30% within range but volume still alive ---
  if (inRange) {
    const rangeLower = position.bin_range_lower ?? 0
    const rangeUpper = position.bin_range_upper ?? 0
    const rangeWidth = rangeUpper - rangeLower
    const positionInRange = rangeWidth > 0
      ? ((currentPrice - rangeLower) / rangeWidth) * 100  // 0=bottom, 100=top of range
      : 50

    const driftedHighInRange = positionInRange > (50 + SMART_REBALANCE_THRESHOLD_PCT / 2)
    const driftedLowInRange  = positionInRange < (50 - SMART_REBALANCE_THRESHOLD_PCT / 2)

    if ((driftedHighInRange || driftedLowInRange) && volume1hUsd >= MIN_VOLUME_USD_FOR_REBALANCE) {
      console.log(`${label} SMART REBALANCE — price at ${positionInRange.toFixed(0)}% of range, vol=$${volume1hUsd.toFixed(0)}/h`)

      const closed = await closePosition(position.id, `smart_rebalance_${positionInRange.toFixed(0)}pct`)
      if (closed) {
        stats.rebalanced++
        await sendAlert({
          type: 'position_closed',
          symbol: position.token_symbol,
          strategy: strategy.id,
          reason: `smart_rebalance (price at ${positionInRange.toFixed(0)}% of range)`,
          feesEarnedSol,
          ilPct,
          ageHours: Math.round(ageHours * 10) / 10,
        })

        // Reopen centered on current price
        try {
          const metrics = {
            address: position.token_address,
            symbol: position.token_symbol,
            poolAddress: position.pool_address,
            priceUsd: currentPrice,
            // remaining TokenMetrics fields — sensible defaults for reopen
            marketCapUsd: 0,
            liquidityUsd: 0,
            volume1hUsd,
            volume24hUsd: 0,
            priceChange1h: 0,
            holderCount: 0,
            rugcheckScore: 0,
          }
          await openPosition(metrics, strategy)
          console.log(`${label} reopened centered at $${currentPrice}`)
        } catch (reopenErr) {
          console.error(`${label} reopen after rebalance failed:`, reopenErr)
        }
      }
      return
    }
  }

  // --- Fee claiming ---
  if (strategy.exits.claimFeesBeforeClose && feesEarnedSol >= strategy.exits.minFeesToClaim) {
    console.log(`${label} claiming fees: ${feesEarnedSol.toFixed(4)} SOL`)
    stats.claimed++
    await withTimeout(
      supabase.from('bot_logs').insert({ level: 'info', event: 'fees_claimable', payload: { positionId: position.id, symbol: position.token_symbol, feesEarnedSol } }),
      SUPABASE_TIMEOUT_MS, 'bot_logs fees'
    )
  }

  // --- OOR alert ---
  if (!inRange && position.status === 'active') {
    await sendAlert({ type: 'position_oor', symbol: position.token_symbol, strategy: strategy.id, currentPrice, binRangeLower: position.bin_range_lower, binRangeUpper: position.bin_range_upper, oorExitMinutes: strategy.exits.outOfRangeMinutes })
  }
}

async function fetchPositionState(
  poolAddress: string,
  positionPubKeyStr?: string
): Promise<{ inRange: boolean; currentPrice: number; feesEarnedSol: number; volume1hUsd: number }> {
  const fallback = { inRange: true, currentPrice: 0, feesEarnedSol: 0, volume1hUsd: 0 }
  try {
    const connection = getConnection()
    const wallet     = getWallet()
    const dlmmPool   = await DLMM.create(connection, new PublicKey(poolAddress))
    const activeBin  = await dlmmPool.getActiveBin()
    const currentPrice = parseFloat(activeBin.pricePerToken)

    // Fetch 1h volume from Meteora stats endpoint (best-effort)
    let volume1hUsd = 0
    try {
      const statsUrl = `https://dlmm-api.meteora.ag/pair/${poolAddress}`
      const statsRes = await fetch(statsUrl, { signal: AbortSignal.timeout(4000) })
      if (statsRes.ok) {
        const stats = await statsRes.json()
        volume1hUsd = stats?.trade_volume_usd ?? stats?.volume?.h1 ?? 0
      }
    } catch { /* non-fatal */ }

    if (!positionPubKeyStr) return { ...fallback, currentPrice, volume1hUsd }

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const pos = userPositions.find((p) => p.publicKey.toBase58() === positionPubKeyStr)
    if (!pos) return { ...fallback, currentPrice, volume1hUsd }

    const { lowerBinId, upperBinId, feeY } = pos.positionData
    const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId
    const feesEarnedSol = feeY.toNumber() / 1e9
    return { inRange, currentPrice, feesEarnedSol, volume1hUsd }
  } catch (err) {
    console.error(`[monitor] fetchPositionState failed for pool ${poolAddress}:`, err)
    return fallback
  }
}
