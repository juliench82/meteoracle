import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import {
  MONITOR_INTERVAL_MS,
  SYNC_FAIL_ALERT_THRESHOLD,
  DAMM_EDGE_EXIT_STRATEGY,
  LIVE_CACHE_EXIT_STRATEGY_ID,
  LIVE_CACHE_ALERT_INTERVAL_MS,
  ORPHAN_CHECK_EVERY_N,
  fetchLiveSolPriceUsd,
  sbSelect,
  isLpPositionRow,
  _unmanagedLiveAlertAt,
} from './monitor-core'
import { checkDlmmPosition } from './monitor-dlmm'
import { checkDammEdgePosition } from './monitor-damm'
import { detectAllOrphanedPositions } from './orphan-detector'
import { checkMoonboyPositions } from './moonboy-executor'
import { retryStrandedSells } from '@/lib/swap'
import { STRATEGIES } from '@/strategies'
import { fetchLiveMeteoraSnapshot, mergeDbAndLiveLpPositions } from '@/lib/meteora-live'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { syncAllMeteoraPositions } from '@/lib/position-sync'
import { getBotState, incrementSyncFailCount, resetSyncFailCount } from '@/lib/botState'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import { sendAlert } from './alerter'
import { sendStartupAlert } from './startup-alert'
import type { Strategy } from '@/lib/types'

// Re-export for any existing imports
export { DAMM_EDGE_EXIT_STRATEGY, LIVE_CACHE_EXIT_STRATEGY_ID }
export async function monitorPositions() { return runTick() }

console.log('[monitor] split complete — using monitor-core + monitor-damm + monitor-dlmm')

const LP_MONITOR_ENABLED   = process.env.LP_MONITOR_ENABLED    !== 'false'
const MONITOR_EXITS_ENABLED = process.env.MONITOR_EXITS_ENABLED !== 'false'

let tickCount = 0

async function runTick(): Promise<{ checked: number; closed: number; claimed: number; rebalanced: number }> {
  const stats = { checked: 0, closed: 0, claimed: 0, rebalanced: 0 }

  const botState = await getBotState().catch(() => ({ paused: false }))
  if (botState.paused) {
    console.log('[lp-monitor] bot is paused — skipping tick')
    return stats
  }

  tickCount++
  console.log('[lp-monitor] tick start')

  // ── Moonboy ──────────────────────────────────────────────────────────────
  await checkMoonboyPositions().catch(err =>
    console.error('[monitor] moonboy check failed:', err),
  )

  // ── Stranded sells ───────────────────────────────────────────────────────
  await retryStrandedSells().catch(err =>
    console.error('[monitor] retryStrandedSells failed:', err),
  )

  // ── Live Meteora snapshot ─────────────────────────────────────────────────
  const liveSolPriceUsd = await fetchLiveSolPriceUsd()

  let snapshot: Awaited<ReturnType<typeof fetchLiveMeteoraSnapshot>> | null = null
  try {
    snapshot = await fetchLiveMeteoraSnapshot()
    resetSyncFailCount()
  } catch (err) {
    const failCount = await incrementSyncFailCount()
    console.error(`[monitor] live Meteora sync failed (${failCount}):`, err)
    if (failCount >= SYNC_FAIL_ALERT_THRESHOLD) {
      await sendAlert({
        type: 'sync_failure_alert',
        reason: `live_sync_failed_${failCount}x`,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {})
    }
  }

  const livePositions = snapshot?.positions ?? []

  // Sync DB from live snapshot
  if (snapshot) {
    await syncAllMeteoraPositions(livePositions).catch(err =>
      console.error('[monitor] syncAllMeteoraPositions failed:', err),
    )
  }

  // ── Orphan detection (every N ticks) ─────────────────────────────────────
  if (tickCount % ORPHAN_CHECK_EVERY_N === 0) {
    console.log(`[monitor] tick ${tickCount} — reconciling wallet positions from Meteora`)
    await detectAllOrphanedPositions(livePositions).catch(err =>
      console.error('[monitor] orphan detection failed:', err),
    )
  }

  if (!LP_MONITOR_ENABLED || !MONITOR_EXITS_ENABLED) {
    console.log('[lp-monitor] exits disabled — tick done')
    return stats
  }

  // ── Fetch open DB positions ───────────────────────────────────────────────
  const dbRows = await sbSelect<any>(
    'lp_positions',
    `status=in.(${OPEN_LP_STATUSES.join(',')})&select=*`,
  ).catch(err => {
    console.error('[monitor] DB fetch failed:', err)
    return [] as any[]
  })

  const openRows = dbRows.filter(isLpPositionRow)
  const merged = mergeDbAndLiveLpPositions(openRows, livePositions)

  // ── RPC cooldown refresh ──────────────────────────────────────────────────
  refreshRpcProviderCooldown()

  // ── Per-position checks ───────────────────────────────────────────────────
  for (const position of merged) {
    const strategyId = position.strategy_id ?? ''
    stats.checked++

    // DAMM edge positions
    const isDammManaged =
      ['pre_grad', 'pre-grad', 'damm-edge', 'damm-migration', 'damm-launch'].includes(strategyId) ||
      ['pre_grad', 'pre-grad', 'damm-edge', 'damm-migration', 'damm-launch'].includes(position.position_type ?? '')

    if (isDammManaged) {
      await checkDammEdgePosition(position, DAMM_EDGE_EXIT_STRATEGY, stats, liveSolPriceUsd).catch(err =>
        console.error(`[monitor][${position.symbol}][damm] tick error:`, err),
      )
      continue
    }

    // Live-cache rows without an exit strategy
    if (strategyId === 'meteora-live') {
      const posId = String(position.id)
      const now = Date.now()
      const lastAlertAt = _unmanagedLiveAlertAt.get(posId) ?? 0
      if (now - lastAlertAt > LIVE_CACHE_ALERT_INTERVAL_MS) {
        _unmanagedLiveAlertAt.set(posId, now)
        if (!LIVE_CACHE_EXIT_STRATEGY_ID) {
          console.warn(
            `[monitor] ${position.symbol} is a live Meteora cache row without an exit policy ` +
            `(strategy_id=meteora-live). Set MONITOR_LIVE_CACHE_EXIT_STRATEGY_ID to a real strategy id ` +
            `or close/adopt position ${posId} manually. Current setting: unset`,
          )
        }
      } else {
        console.log(`[monitor] ${position.symbol} remains unmanaged live cache row — alert throttled`)
      }
      continue
    }

    // DLMM positions — match against known strategies
    const strategy: Strategy | undefined =
      STRATEGIES.find((s: Strategy) => s.id === strategyId) as Strategy | undefined
    if (!strategy) {
      console.warn(`[monitor][${position.symbol}] unknown strategy_id="${strategyId}" — skipping`)
      continue
    }

    await checkDlmmPosition(position, strategy, stats, liveSolPriceUsd).catch(err =>
      console.error(`[monitor][${position.symbol}][${strategy.id}] tick error:`, err),
    )
  }

  console.log(
    `[lp-monitor] tick done — checked=${stats.checked} closed=${stats.closed} ` +
    `claimed=${stats.claimed} rebalanced=${stats.rebalanced} elapsed=${Date.now() - (Date.now() - MONITOR_INTERVAL_MS)}ms`,
  )

  return stats
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await sendStartupAlert('lp-monitor-dlmm')

  // Immediate first tick, then interval
  await runTick().catch(err => console.error('[lp-monitor] first tick failed:', err))

  setInterval(() => {
    runTick().catch(err => console.error('[lp-monitor] tick failed:', err))
  }, MONITOR_INTERVAL_MS)
}

main().catch(err => {
  console.error('[lp-monitor] fatal startup error:', err)
  process.exit(1)
})
