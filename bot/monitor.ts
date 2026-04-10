import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import DLMM from '@meteora-ag/dlmm'
import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { closePosition, openPosition } from '@/bot/executor'
import { sendAlert } from '@/bot/alerter'
import { STRATEGIES } from '@/strategies'
import type { Strategy, TokenMetrics } from '@/lib/types'

const SUPABASE_TIMEOUT_MS = 5_000
const SMART_REBALANCE_THRESHOLD_PCT = 30
const MIN_VOLUME_USD_FOR_REBALANCE = 500
const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '300') * 1_000  // default 5min

const HARD_EXIT_PREFIXES = ['stoploss', 'out_of_range', 'max_duration', 'takeprofit']

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

  const { inRange, currentPriceSol, feesEarnedSol, volume1hUsd } = await fetchPositionState(
    position.pool_address,
    position.metadata?.positionPubKey
  )

  const entryPriceSol: number = position.entry_price ?? position.metadata?.entryPriceSol ?? 0
  const pricePct = entryPriceSol > 0
    ? ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100
    : 0

  const k = entryPriceSol > 0 && currentPriceSol > 0 ? currentPriceSol / entryPriceSol : 1
  const ilPct = entryPriceSol > 0
    ? Math.round((2 * Math.sqrt(k) / (1 + k) - 1) * 10000) / 100
    : 0

  const pnlSol = entryPriceSol > 0
    ? Math.round((position.sol_deposited * (pricePct / 100) + feesEarnedSol) * 1e6) / 1e6
    : Math.round(feesEarnedSol * 1e6) / 1e6

  const wasInRange = position.status === 'active'
  const justWentOOR = !inRange && wasInRange
  const oorSinceAt: string | null = justWentOOR
    ? new Date().toISOString()
    : (!inRange ? (position.oor_since_at ?? new Date().toISOString()) : null)

  const updatePayload: Record<string, unknown> = {
    current_price:   currentPriceSol,
    in_range:        inRange,
    fees_earned_sol: feesEarnedSol,
    il_pct:          ilPct,
    pnl_sol:         pnlSol,
    status:          inRange ? 'active' : 'out_of_range',
    oor_since_at:    oorSinceAt,
  }

  await withTimeout(
    supabase.from('positions').update(updatePayload).eq('id', position.id),
    SUPABASE_TIMEOUT_MS, 'positions update'
  )

  const openedAt = new Date(position.opened_at).getTime()
  const ageHours = (now - openedAt) / (1000 * 60 * 60)

  const oorSince = !inRange && oorSinceAt
    ? (now - new Date(oorSinceAt).getTime()) / 60_000
    : 0

  console.log(`${label} inRange=${inRange} price=${currentPriceSol.toFixed(9)} entry=${entryPriceSol.toFixed(9)} age=${ageHours.toFixed(1)}h oorMin=${oorSince.toFixed(0)}`)

  let closeReason: string | null = null
  if (!inRange && oorSince >= strategy.exits.outOfRangeMinutes)
    closeReason = `out_of_range_${Math.round(oorSince)}min`
  else if (entryPriceSol > 0 && pricePct <= strategy.exits.stopLossPct)
    closeReason = `stoploss_${pricePct.toFixed(1)}pct`
  else if (entryPriceSol > 0 && pricePct >= strategy.exits.takeProfitPct)
    closeReason = `takeprofit_${pricePct.toFixed(1)}pct`
  else if (ageHours >= strategy.exits.maxDurationHours)
    closeReason = `max_duration_${Math.round(ageHours)}h`

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

  if (inRange) {
    const rangeLower = position.bin_range_lower ?? 0
    const rangeUpper = position.bin_range_upper ?? 0
    const rangeWidth = rangeUpper - rangeLower
    const positionInRange = rangeWidth > 0
      ? ((currentPriceSol - rangeLower) / rangeWidth) * 100
      : 50

    const driftedHighInRange = positionInRange > (50 + SMART_REBALANCE_THRESHOLD_PCT / 2)
    const driftedLowInRange  = positionInRange < (50 - SMART_REBALANCE_THRESHOLD_PCT / 2)

    if ((driftedHighInRange || driftedLowInRange) && volume1hUsd >= MIN_VOLUME_USD_FOR_REBALANCE) {
      console.log(`${label} SMART REBALANCE — price at ${positionInRange.toFixed(0)}% of range, vol=$${volume1hUsd.toFixed(0)}/h`)

      const rebalanceReason = `smart_rebalance_${positionInRange.toFixed(0)}pct`
      const closed = await closePosition(position.id, rebalanceReason)
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

        const isHardExit = HARD_EXIT_PREFIXES.some(prefix => rebalanceReason.startsWith(prefix))
        if (!isHardExit) {
          try {
            const metrics: TokenMetrics = {
              address: position.token_address,
              symbol: position.token_symbol,
              poolAddress: position.pool_address,
              priceUsd: currentPriceSol,
              dexId: position.metadata?.dexId ?? 'meteora',
              mcUsd: 0, volume24h: 0, liquidityUsd: 0,
              topHolderPct: 0, holderCount: 0, ageHours,
              rugcheckScore: 0,
            }
            await openPosition(metrics, strategy)
            console.log(`${label} reopened centered at ${currentPriceSol}`)
          } catch (reopenErr) {
            console.error(`${label} reopen after rebalance failed:`, reopenErr)
          }
        }
      }
      return
    }
  }

  if (strategy.exits.claimFeesBeforeClose && feesEarnedSol >= strategy.exits.minFeesToClaim) {
    console.log(`${label} claiming fees: ${feesEarnedSol.toFixed(4)} SOL`)
    stats.claimed++
    await withTimeout(
      supabase.from('bot_logs').insert({
        level: 'info', event: 'fees_claimable',
        payload: { positionId: position.id, symbol: position.token_symbol, feesEarnedSol },
      }),
      SUPABASE_TIMEOUT_MS, 'bot_logs fees'
    )
  }

  if (justWentOOR) {
    await sendAlert({
      type: 'position_oor',
      symbol: position.token_symbol,
      strategy: strategy.id,
      currentPrice: currentPriceSol,
      binRangeLower: position.bin_range_lower,
      binRangeUpper: position.bin_range_upper,
      oorExitMinutes: strategy.exits.outOfRangeMinutes,
    })
  }
}

function getDecimalAdjustedPrice(dlmmPool: DLMM, activeBin: { price: string; pricePerToken: string }): number {
  try {
    const adjusted = dlmmPool.fromPricePerLamport(Number(activeBin.price))
    const price = parseFloat(adjusted)
    if (isFinite(price) && price > 0) return price
  } catch { /* fall through */ }
  return parseFloat(activeBin.pricePerToken)
}

async function fetchPositionState(
  poolAddress: string,
  positionPubKeyStr?: string
): Promise<{ inRange: boolean; currentPriceSol: number; feesEarnedSol: number; volume1hUsd: number }> {
  const fallback = { inRange: false, currentPriceSol: 0, feesEarnedSol: 0, volume1hUsd: 0 }
  try {
    const connection = getConnection()
    const wallet     = getWallet()
    const dlmmPool   = await DLMM.create(connection, new PublicKey(poolAddress))
    const activeBin  = await dlmmPool.getActiveBin()
    const currentPriceSol = getDecimalAdjustedPrice(dlmmPool, activeBin)

    let volume1hUsd = 0
    try {
      const statsRes = await fetch(`https://dlmm-api.meteora.ag/pair/${poolAddress}`, { signal: AbortSignal.timeout(4000) })
      if (statsRes.ok) {
        const stats = await statsRes.json()
        volume1hUsd = stats?.trade_volume_usd ?? stats?.volume?.h1 ?? 0
      }
    } catch { /* non-fatal */ }

    if (!positionPubKeyStr) {
      console.warn(`[monitor] fetchPositionState: no positionPubKey for pool ${poolAddress} — assuming inRange=true`)
      return { inRange: true, currentPriceSol, feesEarnedSol: 0, volume1hUsd }
    }

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const pos = userPositions.find((p) => p.publicKey.toBase58() === positionPubKeyStr)
    if (!pos) {
      console.warn(`[monitor] fetchPositionState: position ${positionPubKeyStr} not found on-chain — assuming closed/OOR`)
      return { ...fallback, currentPriceSol, volume1hUsd }
    }

    const { lowerBinId, upperBinId, feeY } = pos.positionData
    const inRange = activeBin.binId >= lowerBinId && activeBin.binId <= upperBinId
    const feesEarnedSol = feeY.toNumber() / 1e9
    return { inRange, currentPriceSol, feesEarnedSol, volume1hUsd }
  } catch (err) {
    console.error(`[monitor] fetchPositionState failed for pool ${poolAddress}:`, err)
    return fallback
  }
}

// ─── Standalone entrypoint (PM2) ────────────────────────────────────────────

if (require.main === module || process.env.LP_MONITOR_STANDALONE === 'true') {
  const label = '[lp-monitor-dlmm]'
  console.log(`${label} starting — poll every ${MONITOR_INTERVAL_MS / 1000}s`)

  async function tick() {
    try {
      const result = await monitorPositions()
      console.log(`${label} tick done — checked=${result.checked} closed=${result.closed} claimed=${result.claimed} rebalanced=${result.rebalanced}`)
    } catch (err) {
      console.error(`${label} tick error:`, err)
    }
  }

  tick().then(() => setInterval(tick, MONITOR_INTERVAL_MS))
}
