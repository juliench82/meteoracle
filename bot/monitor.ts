import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import { closePosition, openPosition } from '@/bot/executor'
import { sendAlert } from '@/bot/alerter'
import { STRATEGIES } from '@/strategies'
import type { Strategy, TokenMetrics } from '@/lib/types'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '300') * 1_000
const SMART_REBALANCE_THRESHOLD_PCT = 30
const MIN_VOLUME_USD_FOR_REBALANCE = 500
const HARD_EXIT_PREFIXES = ['stoploss', 'out_of_range', 'max_duration', 'takeprofit']

// ── Direct REST helpers (bypasses supabase-js connection pooling issues) ──────

function sbUrl(): string {
  const u = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!u) throw new Error('SUPABASE_URL not set')
  return u
}

function sbKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return k
}

function sbHeaders() {
  return {
    'apikey': sbKey(),
    'Authorization': `Bearer ${sbKey()}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
  }
}

async function sbSelect<T>(table: string, params: string): Promise<T[]> {
  const res = await fetch(`${sbUrl()}/rest/v1/${table}?${params}`, {
    headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`sbSelect ${table} ${res.status}: ${await res.text()}`)
  return res.json()
}

async function sbUpdate(table: string, matchParam: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${sbUrl()}/rest/v1/${table}?${matchParam}`, {
    method: 'PATCH',
    headers: sbHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`sbUpdate ${table} ${res.status}: ${await res.text()}`)
}

async function sbInsert(table: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${sbUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`sbInsert ${table} ${res.status}: ${await res.text()}`)
}

// ─────────────────────────────────────────────────────────────────────────────

export async function monitorPositions(): Promise<{
  checked: number
  closed: number
  claimed: number
  rebalanced: number
}> {
  const state = await getBotState()
  if (!state.enabled) {
    console.log('[monitor] bot is stopped — skipping tick')
    return { checked: 0, closed: 0, claimed: 0, rebalanced: 0 }
  }

  const stats = { checked: 0, closed: 0, claimed: 0, rebalanced: 0 }

  console.log('[monitor] fetching open LP positions')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let positions: any[]
  try {
    positions = await sbSelect('lp_positions', 'status=in.(active,out_of_range)&order=opened_at.desc')
  } catch (err) {
    console.warn('[monitor] lp_positions fetch error:', err)
    return stats
  }

  if (!positions.length) { console.log('[monitor] no open LP positions'); return stats }
  console.log(`[monitor] checking ${positions.length} LP positions`)

  for (const position of positions) {
    try {
      stats.checked++
      const strategyId = position.strategy_id ?? position.metadata?.strategy_id
      const strategy = STRATEGIES.find((s) => s.id === strategyId)
      if (!strategy) {
        console.warn(`[monitor] no strategy found for position ${position.id} (strategy_id=${strategyId})`)
        continue
      }
      await checkPosition(position, strategy, stats)
    } catch (err) {
      console.error(`[monitor] error checking position ${position.id}:`, err)
      try {
        await sbInsert('bot_logs', {
          level: 'error', event: 'monitor_check_failed',
          payload: { positionId: position.id, error: String(err) },
        })
      } catch { /* non-fatal */ }
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
  const label = `[monitor][${position.symbol}][${strategy.id}]`
  const now = Date.now()

  const { inRange, currentPriceSol, feesEarnedSol, volume1hUsd } = await fetchPositionState(
    position.pool_address,
    position.position_pubkey
  )

  if (currentPriceSol === 0) {
    console.warn(`${label} price read returned 0 — RPC fallback hit, skipping tick`)
    return
  }

  // entry_price_sol is a top-level column; metadata fallback for legacy rows
  const entryPriceSol: number = position.entry_price_sol ?? position.metadata?.entry_price_sol ?? 0

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

  const rangeLower = position.metadata?.bin_range_down
    ? entryPriceSol * (1 + position.metadata.bin_range_down / 100)
    : 0
  const rangeUpper = position.metadata?.bin_range_up
    ? entryPriceSol * (1 + position.metadata.bin_range_up / 100)
    : 0

  try {
    await sbUpdate('lp_positions', `id=eq.${position.id}`, {
      current_price:   currentPriceSol,
      in_range:        inRange,
      fees_earned_sol: feesEarnedSol,
      il_pct:          ilPct,
      pnl_sol:         pnlSol,
      status:          inRange ? 'active' : 'out_of_range',
      oor_since_at:    oorSinceAt,
    })
  } catch (err) {
    console.error(`${label} DB update failed:`, err)
  }

  const openedAt = new Date(position.opened_at).getTime()
  const ageHours = (now - openedAt) / (1000 * 60 * 60)
  const oorSince = !inRange && oorSinceAt
    ? (now - new Date(oorSinceAt).getTime()) / 60_000
    : 0

  console.log(`${label} inRange=${inRange} price=${currentPriceSol.toFixed(9)} entry=${entryPriceSol.toFixed(9)} pnl=${pnlSol.toFixed(6)} age=${ageHours.toFixed(1)}h oorMin=${oorSince.toFixed(0)}`)

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
        symbol: position.symbol,
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
          symbol: position.symbol,
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
              address: position.mint,
              symbol: position.symbol,
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
    try {
      await sbInsert('bot_logs', {
        level: 'info', event: 'fees_claimable',
        payload: { positionId: position.id, symbol: position.symbol, feesEarnedSol },
      })
    } catch { /* non-fatal */ }
  }

  if (justWentOOR) {
    await sendAlert({
      type: 'position_oor',
      symbol: position.symbol,
      strategy: strategy.id,
      currentPrice: currentPriceSol,
      binRangeLower: rangeLower,
      binRangeUpper: rangeUpper,
      oorExitMinutes: strategy.exits.outOfRangeMinutes,
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDecimalAdjustedPrice(dlmmPool: any, activeBin: { price: string; pricePerToken: string }): number {
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
    const DLMM       = await getDLMM()
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
      console.warn(`[monitor] no position_pubkey for pool ${poolAddress} — assuming inRange=true`)
      return { inRange: true, currentPriceSol, feesEarnedSol: 0, volume1hUsd }
    }

    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const pos = userPositions.find((p) => p.publicKey.toBase58() === positionPubKeyStr)
    if (!pos) {
      console.warn(`[monitor] position ${positionPubKeyStr} not found on-chain — assuming closed/OOR`)
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

// ─── Standalone entrypoint (PM2) ──────────────────────────────────────────────

const standaloneMonitorTick = async (): Promise<void> => {
  const label = '[lp-monitor-dlmm]'
  try {
    const result = await monitorPositions()
    console.log(`${label} tick done — checked=${result.checked} closed=${result.closed} claimed=${result.claimed} rebalanced=${result.rebalanced}`)
  } catch (err) {
    console.error(`${label} tick error:`, err)
  }
}

if (require.main === module || process.env.LP_MONITOR_STANDALONE === 'true') {
  const label = '[lp-monitor-dlmm]'
  console.log(`${label} starting — poll every ${MONITOR_INTERVAL_MS / 1000}s`)
  standaloneMonitorTick().then(() => setInterval(standaloneMonitorTick, MONITOR_INTERVAL_MS))
}
