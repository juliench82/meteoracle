import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true, quiet: true })

import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet, warnIfPublicFallbackActive } from '@/lib/solana'
import { getBotState, incrementSyncFailCount, resetSyncFailCount } from '@/lib/botState'
import { closePosition } from '@/bot/executor'
import { closeDammPosition } from '@/bot/damm-executor'
import { rebalanceDlmmPosition } from '@/bot/rebalance'
import { checkDammPositions } from '@/lib/pre-grad'
import { sendAlert } from '@/bot/alerter'
import { detectAllOrphanedPositions } from '@/bot/orphan-detector'
import { STRATEGIES } from '@/strategies'
import { mergeDbAndLiveLpPositions, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { syncAllMeteoraPositions, type MeteoraPositionSyncResult } from '@/lib/position-sync'
import { getSupabaseRestHeaders, getSupabaseUrl } from '@/lib/supabase'
import { refreshRpcProviderCooldown } from '@/lib/rpc-rate-limit'
import type { Strategy } from '@/lib/types'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1_000
const SMART_REBALANCE_THRESHOLD_PCT = 30
const SMART_REBALANCE_IN_RANGE = process.env.LP_SMART_REBALANCE_IN_RANGE === 'true'
const MONITOR_EXITS_ENABLED = process.env.MONITOR_EXITS_ENABLED !== 'false' &&
  process.env.LP_MONITOR_ENABLED !== 'false'

// How many consecutive syncAllMeteoraPositions failures before we fire a Telegram alert.
// Counter is now persisted in bot_state.sync_fail_count so it survives process restarts.
const SYNC_FAIL_ALERT_THRESHOLD = parseInt(process.env.MONITOR_SYNC_FAIL_ALERT_THRESHOLD ?? '3')

const DAMM_EDGE_EXIT_STRATEGY: Strategy = {
  id: 'damm-edge',
  name: 'DAMM Edge',
  description: 'DAMM v2 market-edge exit policy.',
  enabled: true,
  filters: {
    minMcUsd: 0,
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 0,
    minLiquidityUsd: 0,
    maxTopHolderPct: 100,
    minHolderCount: 0,
    maxAgeHours: Number.MAX_SAFE_INTEGER,
    minRugcheckScore: 0,
    requireSocialSignal: false,
    minFeeTvl24hPct: 0,
  },
  position: {
    binStep: 0,
    rangeDownPct: 0,
    rangeUpPct: 0,
    distributionType: 'spot',
    solBias: 1,
  },
  exits: {
    stopLossPct: -30,
    takeProfitPct: 40,
    outOfRangeMinutes: 0,
    maxDurationHours: 72,
    claimFeesBeforeClose: true,
    minFeesToClaim: 0,
  },
}

const ORPHAN_CHECK_EVERY_N = parseInt(process.env.ORPHAN_CHECK_EVERY_N ?? '1')
let tickCount = 0
const PNL_UNAVAILABLE_ALERT_TICKS = 3
const PNL_UNAVAILABLE_FORCE_EXIT_TICKS = 10

type PositionStateRead = {
  ok: boolean
  inRange: boolean
  currentPriceSol: number
  claimableFeesSolEquivalent: number
  externallyClosed: boolean
}

type PositionMetadata = {
  strategy_id?: string | null
  entry_price_sol?: unknown
  bin_range_down?: unknown
  bin_range_up?: unknown
  sol_price_usd?: unknown
  current_sol_price_usd?: unknown
  pnl_pct?: unknown
  position_pnl_pct?: unknown
  position_pnl_percentage?: unknown
  pnl_percentage?: unknown
  total_pnl_pct?: unknown
  total_pnl_percentage?: unknown
  pnl_usd?: unknown
  position_pnl_usd?: unknown
  total_pnl_usd?: unknown
  meteora_total_deposit_usd?: unknown
  total_deposit_usd?: unknown
  deposit_usd?: unknown
  cost_basis_usd?: unknown
  claimable_fees_usd?: unknown
  position_value_usd?: unknown
  [key: string]: unknown
}

type LpPositionRow = {
  id: string
  symbol: string
  pool_address: string
  position_pubkey: string
  status: string
  opened_at: string
  strategy_id?: string | null
  position_type?: string | null
  metadata?: PositionMetadata | null
  in_range?: boolean | null
  oor_since_at?: string | null
  entry_price_sol?: unknown
  pnl_pct?: unknown
  pnl_usd?: unknown
  claimable_fees_usd?: unknown
  position_value_usd?: unknown
  sol_deposited?: unknown
  null_pnl_ticks?: unknown
}

type DammPositionSnapshotRow = {
  pnl_pct: number | null
  position_value_usd: number | null
  opened_at: string
  metadata: PositionMetadata | null
  null_pnl_ticks: number | null
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function roundMoney(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function roundPct(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = nullableNumber(value)
    if (n !== null) return n
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLpPositionRow(value: unknown): value is LpPositionRow {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' &&
    typeof value.symbol === 'string' &&
    typeof value.pool_address === 'string' &&
    typeof value.position_pubkey === 'string' &&
    typeof value.status === 'string' &&
    typeof value.opened_at === 'string'
}

function resolveMeteoraPnlPct(position: LpPositionRow, pnlUsd: number | null, deployedSol: number): number | null {
  const metadata = position.metadata ?? {}
  const explicitPct = firstNumber(
    position.pnl_pct,
    metadata.pnl_pct,
    metadata.position_pnl_pct,
    metadata.position_pnl_percentage,
    metadata.pnl_percentage,
    metadata.total_pnl_pct,
    metadata.total_pnl_percentage,
  )
  if (explicitPct !== null) return explicitPct

  if (pnlUsd === null || deployedSol <= 0) return null
  const costBasisUsd = firstNumber(
    metadata.meteora_total_deposit_usd,
    metadata.total_deposit_usd,
    metadata.deposit_usd,
    metadata.cost_basis_usd,
  ) ?? (() => {
    const solPriceUsd = firstNumber(metadata.sol_price_usd, metadata.current_sol_price_usd)
    return solPriceUsd !== null && solPriceUsd > 0 ? deployedSol * solPriceUsd : null
  })()

  if (costBasisUsd === null || costBasisUsd <= 0) return null
  return roundPct((pnlUsd / costBasisUsd) * 100)
}

async function sbSelect<T>(table: string, params: string): Promise<T[]> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?${params}`, {
    headers: getSupabaseRestHeaders('representation'),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`sbSelect ${table} ${res.status}: ${await res.text()}`)
  return res.json()
}

async function sbUpdate(table: string, matchParam: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}?${matchParam}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`sbUpdate ${table} ${res.status}: ${await res.text()}`)
}

async function sbInsert(table: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/${table}`, {
    method: 'POST',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`sbInsert ${table} ${res.status}: ${await res.text()}`)
}

async function fetchCachedRowsForLivePositions(livePositions: LiveMeteoraPosition[]): Promise<LpPositionRow[]> {
  const pubkeys = livePositions
    .map(position => position.position_pubkey)
    .filter((pubkey): pubkey is string => Boolean(pubkey))

  if (pubkeys.length === 0) return []
  const rows = await sbSelect<unknown>('lp_positions', `position_pubkey=in.(${pubkeys.join(',')})&select=*`)
  return rows.filter(isLpPositionRow)
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

  await refreshRpcProviderCooldown('helius')

  const stats = { checked: 0, closed: 0, claimed: 0, rebalanced: 0 }
  if (!MONITOR_EXITS_ENABLED) {
    console.log('[monitor] exits disabled — MONITOR_EXITS_ENABLED=false')
    return stats
  }

  tickCount++
  let reconcile: MeteoraPositionSyncResult | null = null
  if (ORPHAN_CHECK_EVERY_N > 0 && tickCount % ORPHAN_CHECK_EVERY_N === 0) {
    console.log(`[monitor] tick ${tickCount} — reconciling wallet positions from Meteora`)
    try {
      reconcile = await detectAllOrphanedPositions()
      await resetSyncFailCount()
      console.log(
        `[monitor] Meteora reconcile — live=${reconcile.live} updated=${reconcile.updated} inserted=${reconcile.inserted} ` +
        `(DLMM ${reconcile.dlmmLive}, DAMM ${reconcile.dammLive})`,
      )
    } catch (err) {
      const failCount = await incrementSyncFailCount()
      console.warn('[monitor] Meteora position reconcile failed (non-fatal):', err)
      if (failCount >= SYNC_FAIL_ALERT_THRESHOLD) {
        await sendAlert({
          type: 'sync_failure_alert',
          reason: `meteora_sync_failed_${failCount}x`,
          error: String(err),
        }).catch(() => {})
      }
    }
  } else {
    try {
      reconcile = await syncAllMeteoraPositions()
      await resetSyncFailCount()
    } catch (err) {
      const failCount = await incrementSyncFailCount()
      console.warn('[monitor] Meteora live sync failed — skipping position exits this tick:', err)
      if (failCount >= SYNC_FAIL_ALERT_THRESHOLD) {
        await sendAlert({
          type: 'sync_failure_alert',
          reason: `meteora_sync_failed_${failCount}x`,
          error: String(err),
        }).catch(() => {})
      }
      return stats
    }
  }

  if (!reconcile) {
    console.warn('[monitor] no live Meteora snapshot available — skipping position exits this tick')
    return stats
  }

  if (!reconcile.dlmmOk && !reconcile.dammOk) {
    const failCount = await incrementSyncFailCount()
    console.warn('[monitor] Meteora live fetch failed for DLMM and DAMM — skipping position exits this tick')
    if (failCount >= SYNC_FAIL_ALERT_THRESHOLD) {
      await sendAlert({
        type: 'sync_failure_alert',
        reason: `meteora_dlmm_and_damm_failed_${failCount}x`,
        error: 'Both DLMM and DAMM live fetch failed',
      }).catch(() => {})
    }
    return stats
  }

  // At least one endpoint recovered — reset counter
  await resetSyncFailCount()

  try {
    if (reconcile.dammOk) {
      const damm = await checkDammPositions(reconcile.positions)
      stats.checked += damm.checked
      stats.closed += damm.exited
    } else {
      console.warn('[monitor] DAMM live fetch failed — skipping DAMM exits this tick')
    }
  } catch (err) {
    console.warn('[monitor] DAMM v2 check failed (non-fatal):', err)
  }

  if (!reconcile.dlmmOk) {
    console.warn('[monitor] DLMM live fetch failed — skipping DLMM exits this tick')
  }

  const liveStrategyPositions = reconcile.positions.filter(position =>
    position.position_type === 'dlmm' ||
    position.position_type === 'damm-edge'
  )
  if (!liveStrategyPositions.length) {
    console.log('[monitor] no live strategy positions')
    return stats
  }

  console.log(`[monitor] joining ${liveStrategyPositions.length} live strategy position(s) with Supabase metadata`)
  let cachedRows: LpPositionRow[]
  try {
    cachedRows = await fetchCachedRowsForLivePositions(liveStrategyPositions)
  } catch (err) {
    console.warn('[monitor] lp_positions metadata fetch error — skipping strategy exits:', err)
    return stats
  }

  const positions = mergeDbAndLiveLpPositions(cachedRows, liveStrategyPositions, { dlmmOk: reconcile.dlmmOk, dammOk: reconcile.dammOk })
    .filter(isLpPositionRow)
    .filter(position => OPEN_LP_STATUSES.includes(position.status))

  if (!positions.length) { console.log('[monitor] no monitorable live strategy positions'); return stats }
  console.log(`[monitor] checking ${positions.length} live-first strategy position(s)`)

  for (const position of positions) {
    try {
      const strategyId = position.strategy_id ?? position.metadata?.strategy_id
      const isDammMigration =
        strategyId === 'damm-migration' ||
        position.position_type === 'damm-migration'
      if (position.position_type === 'pre_grad' || isDammMigration) {
        continue
      }
      if (strategyId === 'meteora-live' || strategyId === 'damm-live') {
        console.log(`[monitor] ${position.symbol} is a Meteora-live cache row — dashboard only, skipping strategy exits`)
        continue
      }

      stats.checked++

      const isDammEdge = strategyId === 'damm-edge' || position.position_type === 'damm-edge'
      const strategy = isDammEdge
        ? DAMM_EDGE_EXIT_STRATEGY
        : STRATEGIES.find((s) => s.id === strategyId)
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
      } catch {}
    }
  }

  return stats
}

async function checkDammEdgePosition(
  position: LpPositionRow,
  strategy: Strategy,
  stats: { checked: number; closed: number; claimed: number; rebalanced: number },
): Promise<void> {
  const label = `[monitor][${position.symbol}][damm-edge]`
  const { pnlPct, ageHours, positionValueUsd, previousNullPnlTicks } = await fetchDammPositionState(position.id)
  const currentNullPnlTicks = pnlPct === null ? previousNullPnlTicks + 1 : 0

  try {
    await sbUpdate('lp_positions', `id=eq.${position.id}`, {
      null_pnl_ticks: currentNullPnlTicks,
    })
  } catch (err) {
    console.error(`${label} null_pnl_ticks update failed:`, err)
  }

  console.log(
    `${label} pnlPct=${pnlPct !== null ? `${pnlPct.toFixed(2)}%` : 'n/a'} ` +
    `age=${ageHours.toFixed(1)}h posValue=$${positionValueUsd ?? 'n/a'} ` +
    `nullPnlTicks=${currentNullPnlTicks}`,
  )

  let closeReason: string | null = null

  if (currentNullPnlTicks >= PNL_UNAVAILABLE_FORCE_EXIT_TICKS) {
    closeReason = `pnl_unavailable_${PNL_UNAVAILABLE_FORCE_EXIT_TICKS}ticks`
  } else if (pnlPct !== null && pnlPct <= strategy.exits.stopLossPct) {
    closeReason = `stoploss_pnl_${pnlPct.toFixed(1)}pct`
  } else if (pnlPct !== null && pnlPct >= strategy.exits.takeProfitPct) {
    closeReason = `takeprofit_pnl_${pnlPct.toFixed(1)}pct`
  } else if (ageHours >= strategy.exits.maxDurationHours) {
    closeReason = `max_duration_${Math.round(ageHours)}h`
  } else if (pnlPct === null) {
    if (currentNullPnlTicks >= PNL_UNAVAILABLE_ALERT_TICKS) {
      if (currentNullPnlTicks === PNL_UNAVAILABLE_ALERT_TICKS || currentNullPnlTicks % PNL_UNAVAILABLE_ALERT_TICKS === 0) {
        await sendAlert({
          type: 'pnl_unavailable_warning',
          symbol: position.symbol,
          strategy: strategy.id,
          positionId: position.id,
          reason: `damm_pnl_unavailable_${currentNullPnlTicks}ticks`,
          ageHours: Math.round(ageHours * 10) / 10,
        })
      }
      console.warn(`${label} DAMM PnL unavailable ${currentNullPnlTicks} consecutive ticks`)
    } else {
      console.warn(`${label} DAMM PnL unavailable — stop-loss/take-profit skipped this tick`)
    }
  }

  if (!closeReason) return

  console.log(`${label} EXIT triggered → ${closeReason}`)
  const closeResult = await closeDammPosition(position.id, closeReason)
  const closed = closeResult.success && !closeResult.skipped
  if (closed) {
    stats.closed++
    await sendAlert({
      type: 'position_closed',
      symbol: position.symbol,
      strategy: 'damm-edge',
      reason: closeReason,
      ilPct: null,
      ageHours: Math.round(ageHours * 10) / 10,
    })
  } else {
    console.warn(`${label} close skipped or failed: ${closeResult.error ?? 'unknown error'}`)
  }
}

async function checkPosition(
  position: LpPositionRow,
  strategy: Strategy,
  stats: { checked: number; closed: number; claimed: number; rebalanced: number }
): Promise<void> {
  const strategyId = position.strategy_id ?? position.metadata?.strategy_id
  const isDammEdge =
    strategyId === 'damm-edge' ||
    position.position_type === 'damm-edge'

  if (isDammEdge) {
    await checkDammEdgePosition(position, strategy, stats)
    return
  }

  const label = `[monitor][${position.symbol}][${strategy.id}]`
  const now = Date.now()

  const state = await fetchPositionState(
    position.pool_address,
    position.position_pubkey
  )

  if (!state.ok) {
    console.warn(`${label} position state read failed — skipping exit checks this tick`)
    return
  }

  const { inRange, currentPriceSol, claimableFeesSolEquivalent, externallyClosed } = state

  if (externallyClosed) {
    console.warn(`${label} position missing on-chain — marking closed in DB`)
    try {
      await sbUpdate('lp_positions', `id=eq.${position.id}`, {
        status: 'closed',
        closed_at: new Date().toISOString(),
        in_range: false,
        oor_since_at: null,
        close_reason: 'external_close_detected',
      })
      stats.closed++
    } catch (err) {
      console.error(`${label} external-close DB update failed:`, err)
    }
    return
  }

  if (currentPriceSol === 0) {
    console.warn(`${label} price read returned 0 — RPC fallback hit, skipping tick`)
    sbInsert('bot_logs', {
      level: 'warn',
      event: 'monitor_rpc_price_zero',
      payload: {
        positionId: position.id,
        symbol: position.symbol,
        poolAddress: position.pool_address,
        reason: 'price_zero_rpc_degraded',
      },
    }).catch(() => {})
    return
  }

  const entryPriceSol = firstNumber(position.entry_price_sol, position.metadata?.entry_price_sol) ?? 0

  const pricePct = entryPriceSol > 0
    ? ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100
    : 0

  const k = entryPriceSol > 0 && currentPriceSol > 0 ? currentPriceSol / entryPriceSol : 1
  const ilPct = entryPriceSol > 0
    ? Math.round((2 * Math.sqrt(k) / (1 + k) - 1) * 10000) / 100
    : 0

  const liveSolPriceUsd = firstNumber(position.metadata?.sol_price_usd, position.metadata?.current_sol_price_usd)
  const derivedClaimableFeesUsd = liveSolPriceUsd !== null
    ? roundMoney(claimableFeesSolEquivalent * liveSolPriceUsd)
    : null
  const liveClaimableFeesUsd = nullableNumber(position.claimable_fees_usd ?? position.metadata?.claimable_fees_usd)
  const livePositionValueUsd = nullableNumber(position.position_value_usd ?? position.metadata?.position_value_usd)
  const livePnlUsd = firstNumber(
    position.pnl_usd,
    position.metadata?.pnl_usd,
    position.metadata?.position_pnl_usd,
    position.metadata?.total_pnl_usd,
  )
  const claimableFeesUsd = liveClaimableFeesUsd ?? derivedClaimableFeesUsd
  const positionValueUsd = livePositionValueUsd
  const deployedSol = firstNumber(position.sol_deposited) ?? 0
  const pnlPct = resolveMeteoraPnlPct(position, livePnlUsd, deployedSol)
  const previousNullPnlTicks = Math.max(0, Math.trunc(nullableNumber(position.null_pnl_ticks) ?? 0))
  const currentNullPnlTicks = pnlPct === null ? previousNullPnlTicks + 1 : 0
  const pnlSol = livePnlUsd !== null && liveSolPriceUsd !== null && liveSolPriceUsd > 0
    ? Math.round((livePnlUsd / liveSolPriceUsd) * 1e6) / 1e6
    : null

  const wasInRange = position.status !== 'out_of_range' && position.in_range !== false
  const justWentOOR = !inRange && wasInRange
  const oorSinceAt: string | null = justWentOOR
    ? new Date().toISOString()
    : (!inRange ? (position.oor_since_at ?? new Date().toISOString()) : null)

  const binRangeDown = firstNumber(position.metadata?.bin_range_down)
  const binRangeUp = firstNumber(position.metadata?.bin_range_up)
  const rangeLower = binRangeDown !== null
    ? entryPriceSol * (1 + binRangeDown / 100)
    : 0
  const rangeUpper = binRangeUp !== null
    ? entryPriceSol * (1 + binRangeUp / 100)
    : 0

  try {
    await sbUpdate('lp_positions', `id=eq.${position.id}`, {
      current_price:     currentPriceSol,
      in_range:          inRange,
      il_pct:            ilPct,
      ...(pnlSol !== null ? { pnl_sol: pnlSol } : {}),
      status:            inRange ? 'active' : 'out_of_range',
      oor_since_at:      oorSinceAt,
      ...(claimableFeesUsd !== null  ? { claimable_fees_usd:  claimableFeesUsd }  : {}),
      ...(positionValueUsd !== null  ? { position_value_usd:  positionValueUsd }  : {}),
      ...(livePnlUsd !== null        ? { pnl_usd:             livePnlUsd }        : {}),
      null_pnl_ticks: currentNullPnlTicks,
      ...(pnlPct !== null || livePnlUsd !== null ? {
        metadata: {
          ...(position.metadata ?? {}),
          ...(livePnlUsd !== null && { pnl_usd: livePnlUsd, position_pnl_usd: livePnlUsd }),
          ...(pnlPct !== null && { pnl_pct: pnlPct, position_pnl_pct: pnlPct }),
          exit_signal_basis: 'meteora_pnl',
        },
      } : {}),
    })
  } catch (err) {
    console.error(`${label} DB update failed:`, err)
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

  const openedAt = new Date(position.opened_at).getTime()
  const ageHours = (now - openedAt) / (1000 * 60 * 60)
  const oorSince = !inRange && oorSinceAt
    ? (now - new Date(oorSinceAt).getTime()) / 60_000
    : 0

  const feeYieldPct = deployedSol > 0 ? (claimableFeesSolEquivalent / deployedSol) * 100 : 0

  console.log(
    `${label} inRange=${inRange} price=${currentPriceSol.toFixed(9)} entry=${entryPriceSol.toFixed(9)}` +
    ` pnlUsd=${livePnlUsd !== null ? `$${livePnlUsd.toFixed(2)}` : 'n/a'}` +
    ` pnlPct=${pnlPct !== null ? `${pnlPct.toFixed(2)}%` : 'n/a'}` +
    ` priceMove=${pricePct.toFixed(1)}% fees=${feeYieldPct.toFixed(1)}%deployed` +
    ` claimable=$${claimableFeesUsd ?? 'n/a'} posValue=$${positionValueUsd ?? 'n/a'}` +
    ` age=${ageHours.toFixed(1)}h oorMin=${oorSince.toFixed(0)}`
  )

  // === EXIT LOGIC ===
  let closeReason: string | null = null

  if (!inRange && oorSince >= strategy.exits.outOfRangeMinutes) {
    const roundedOor = Math.round(oorSince)
    closeReason = `out_of_range_${roundedOor}min`
  } else if (currentNullPnlTicks >= PNL_UNAVAILABLE_FORCE_EXIT_TICKS) {
    closeReason = `pnl_unavailable_${PNL_UNAVAILABLE_FORCE_EXIT_TICKS}ticks`
  } else if (pnlPct !== null && pnlPct <= strategy.exits.stopLossPct) {
    closeReason = `stoploss_pnl_${pnlPct.toFixed(1)}pct`
  } else if (pnlPct !== null && pnlPct >= strategy.exits.takeProfitPct) {
    closeReason = `takeprofit_pnl_${pnlPct.toFixed(1)}pct`
  } else if (ageHours >= strategy.exits.maxDurationHours) {
    closeReason = `max_duration_${Math.round(ageHours)}h`
  } else if (pnlPct === null) {
    if (currentNullPnlTicks >= PNL_UNAVAILABLE_ALERT_TICKS) {
      if (currentNullPnlTicks === PNL_UNAVAILABLE_ALERT_TICKS || currentNullPnlTicks % PNL_UNAVAILABLE_ALERT_TICKS === 0) {
        await sendAlert({
          type: 'pnl_unavailable_warning',
          symbol: position.symbol,
          strategy: strategy.id,
          positionId: position.id,
          reason: `meteora_pnl_unavailable_${currentNullPnlTicks}ticks`,
          ageHours: Math.round(ageHours * 10) / 10,
        })
      }
      console.warn(`${label} Meteora PnL unavailable ${currentNullPnlTicks} consecutive ticks`)
    } else {
      console.warn(`${label} Meteora PnL unavailable — skipping stop-loss/take-profit exits this tick`)
    }
  }

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
        ...(claimableFeesUsd !== null ? { claimableFeesUsd } : {}),
        ilPct,
        ageHours: Math.round(ageHours * 10) / 10,
      })
    }
    return
  }

  if (
    inRange &&
    SMART_REBALANCE_IN_RANGE &&
    strategy.id !== 'scalp-spike' &&
    strategy.id !== 'damm-edge'
  ) {
    const rangeWidth = rangeUpper - rangeLower
    const positionInRange = rangeWidth > 0
      ? ((currentPriceSol - rangeLower) / rangeWidth) * 100
      : 50

    const driftedHighInRange = positionInRange > (50 + SMART_REBALANCE_THRESHOLD_PCT / 2)
    const driftedLowInRange = positionInRange < (50 - SMART_REBALANCE_THRESHOLD_PCT / 2)

    if (driftedHighInRange || driftedLowInRange) {
      console.log(`${label} SMART REBALANCE — price at ${positionInRange.toFixed(0)}% of range`)
      const rebalanceReason = `smart_rebalance_${positionInRange.toFixed(0)}pct`
      const result = await rebalanceDlmmPosition(position.id, {
        reason: rebalanceReason,
        source: 'monitor_smart',
        position,
        liveSourceOk: true,
      })

      if (result.reopened) {
        stats.rebalanced++
      } else if (result.closed) {
        stats.closed++
        console.warn(`${label} smart rebalance closed but reopen failed: ${result.error ?? 'unknown error'}`)
      } else {
        console.warn(`${label} smart rebalance skipped: ${result.error ?? 'unknown error'}`)
      }
    }
  }
}

async function fetchPositionState(
  poolAddress: string,
  positionPubKey: string
): Promise<PositionStateRead> {
  const connection = getConnection()
  const DLMM = await getDLMM()

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
    const activeBin = await dlmmPool.getActiveBin()
    const currentPriceSol = parseFloat(activeBin.pricePerToken)

    const wallet = getWallet()
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const pos = userPositions.find(p => p.publicKey.toBase58() === positionPubKey)

    if (!pos) return { ok: true, inRange: false, currentPriceSol, claimableFeesSolEquivalent: 0, externallyClosed: true }

    const posData = pos.positionData
    const activeBinId = activeBin.binId
    const inRange = activeBinId >= posData.lowerBinId && activeBinId <= posData.upperBinId

    const feeX = Number(posData.feeX ?? 0) / 1e9
    const feeY = Number(posData.feeY ?? 0) / 1e9
    const claimableFeesSolEquivalent = feeX + feeY

    return { ok: true, inRange, currentPriceSol, claimableFeesSolEquivalent, externallyClosed: false }
  } catch (err) {
    console.error(`[fetchPositionState] error for pool ${poolAddress}:`, err)
    return { ok: false, inRange: false, currentPriceSol: 0, claimableFeesSolEquivalent: 0, externallyClosed: false }
  }
}

async function fetchDammPositionState(
  positionId: string,
): Promise<{ pnlPct: number | null; ageHours: number; positionValueUsd: number | null; previousNullPnlTicks: number }> {
  const rows = await sbSelect<DammPositionSnapshotRow>(
    'lp_positions',
    `id=eq.${positionId}&select=pnl_pct,position_value_usd,opened_at,metadata,null_pnl_ticks`,
  )

  if (!rows.length) return { pnlPct: null, ageHours: 0, positionValueUsd: null, previousNullPnlTicks: 0 }

  const row = rows[0]
  const metadata = row.metadata ?? {}
  const pnlPct = nullableNumber(
    row.pnl_pct ??
    metadata.pnl_pct ??
    metadata.position_pnl_pct
  )
  const openedAt = new Date(row.opened_at).getTime()
  const ageHours = Number.isFinite(openedAt)
    ? (Date.now() - openedAt) / 3_600_000
    : 0
  const positionValueUsd = nullableNumber(row.position_value_usd)
  const previousNullPnlTicks = Math.max(0, Math.trunc(nullableNumber(row.null_pnl_ticks) ?? 0))

  return { pnlPct, ageHours, positionValueUsd, previousNullPnlTicks }
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[monitor] starting — interval=${MONITOR_INTERVAL_MS / 1000}s`)

  // Alert via Telegram if no dedicated RPC is configured (public fallback active).
  // warnIfPublicFallbackActive() logs to console; we additionally fire a Telegram
  // alert so it surfaces in the operator's chat rather than being buried in logs.
  if (
    process.env.ENABLE_PUBLIC_RPC_FALLBACK === 'true' &&
    process.env.DISABLE_PUBLIC_RPC_FALLBACK !== 'true' &&
    !process.env.RPC_URL?.trim() &&
    !process.env.HELIUS_API_KEY?.trim() &&
    !process.env.HELIUS_RPC_URL?.trim() &&
    !process.env.SOLANA_RPC_FALLBACK_URLS?.trim()
  ) {
    warnIfPublicFallbackActive()
    sendAlert({
      type: 'rpc_fallback_warning',
      reason: 'no_dedicated_rpc_configured',
      message:
        'No dedicated RPC endpoint is set. Bot is using api.mainnet-beta.solana.com — ' +
        'set RPC_URL or HELIUS_API_KEY, or remove ENABLE_PUBLIC_RPC_FALLBACK=true.',
    }).catch(() => {})
  }

  await monitorPositions()
  setInterval(async () => {
    try {
      await monitorPositions()
    } catch (err) {
      console.error('[monitor] unhandled tick error:', err)
    }
  }, MONITOR_INTERVAL_MS)
}

if (require.main === module || process.env.LP_MONITOR_STANDALONE === 'true') {
  main().catch(err => {
    console.error('[monitor] fatal startup error:', err)
    process.exit(1)
  })
}
