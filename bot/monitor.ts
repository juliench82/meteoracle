import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import { closePosition } from '@/bot/executor'
import { rebalanceDlmmPosition } from '@/bot/rebalance'
import { checkDammPositions } from '@/lib/pre-grad'
import { sendAlert } from '@/bot/alerter'
import { detectAllOrphanedPositions } from '@/bot/orphan-detector'
import { STRATEGIES } from '@/strategies'
import { mergeDbAndLiveLpPositions, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { syncAllMeteoraPositions, type MeteoraPositionSyncResult } from '@/lib/position-sync'
import { getSupabaseRestHeaders, getSupabaseUrl } from '@/lib/supabase'
import type { Strategy } from '@/lib/types'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1_000
const SMART_REBALANCE_THRESHOLD_PCT = 30
const SMART_REBALANCE_IN_RANGE = process.env.LP_SMART_REBALANCE_IN_RANGE === 'true'

// Reconcile the wallet against Meteora every tick by default. Supabase is a cache.
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

function resolveMeteoraPnlPct(position: Record<string, any>, pnlUsd: number | null, deployedSol: number): number | null {
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

async function fetchCachedRowsForLivePositions(livePositions: LiveMeteoraPosition[]): Promise<any[]> {
  const pubkeys = livePositions
    .map(position => position.position_pubkey)
    .filter((pubkey): pubkey is string => Boolean(pubkey))

  if (pubkeys.length === 0) return []
  return sbSelect('lp_positions', `position_pubkey=in.(${pubkeys.join(',')})&select=*`)
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

  tickCount++
  let reconcile: MeteoraPositionSyncResult | null = null
  if (ORPHAN_CHECK_EVERY_N > 0 && tickCount % ORPHAN_CHECK_EVERY_N === 0) {
    console.log(`[monitor] tick ${tickCount} — reconciling wallet positions from Meteora`)
    try {
      reconcile = await detectAllOrphanedPositions()
      console.log(
        `[monitor] Meteora reconcile — live=${reconcile.live} updated=${reconcile.updated} inserted=${reconcile.inserted} ` +
        `(DLMM ${reconcile.dlmmLive}, DAMM ${reconcile.dammLive})`,
      )
    } catch (err) {
      console.warn('[monitor] Meteora position reconcile failed (non-fatal):', err)
    }
  } else {
    try {
      reconcile = await syncAllMeteoraPositions()
    } catch (err) {
      console.warn('[monitor] Meteora live sync failed — skipping position exits this tick:', err)
      return stats
    }
  }

  if (!reconcile) {
    console.warn('[monitor] no live Meteora snapshot available — skipping position exits this tick')
    return stats
  }

  if (!reconcile.dlmmOk && !reconcile.dammOk) {
    console.warn('[monitor] Meteora live fetch failed for DLMM and DAMM — skipping position exits this tick')
    return stats
  }

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

  const liveDlmmPositions = reconcile.positions.filter(position => position.position_type === 'dlmm')
  if (!reconcile.dlmmOk) {
    console.warn('[monitor] DLMM live fetch failed — skipping DLMM exits this tick')
    return stats
  }
  if (!liveDlmmPositions.length) {
    console.log('[monitor] no live DLMM positions')
    return stats
  }

  console.log(`[monitor] joining ${liveDlmmPositions.length} live DLMM position(s) with Supabase metadata`)
  let cachedRows: any[]
  try {
    cachedRows = await fetchCachedRowsForLivePositions(liveDlmmPositions)
  } catch (err) {
    console.warn('[monitor] lp_positions metadata fetch error — skipping strategy exits:', err)
    return stats
  }

  const positions = mergeDbAndLiveLpPositions(cachedRows, liveDlmmPositions, { dlmmOk: true, dammOk: reconcile.dammOk })
    .filter(position => OPEN_LP_STATUSES.includes(position.status))

  if (!positions.length) { console.log('[monitor] no monitorable live DLMM positions'); return stats }
  console.log(`[monitor] checking ${positions.length} live-first DLMM position(s)`)

  for (const position of positions) {
    try {
      const strategyId = position.strategy_id ?? position.metadata?.strategy_id
      const isDammPosition =
        strategyId === 'damm-edge' ||
        strategyId === 'damm-migration' ||
        position.position_type === 'damm-edge' ||
        position.position_type === 'damm-migration'
      if (position.position_type === 'pre_grad' || isDammPosition) {
        continue
      }
      if (strategyId === 'meteora-live' || strategyId === 'damm-live') {
        console.log(`[monitor] ${position.symbol} is a Meteora-live cache row — dashboard only, skipping strategy exits`)
        continue
      }

      stats.checked++

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
      } catch {}
    }
  }

  return stats
}

async function checkPosition(
  position: Record<string, any>,
  strategy: Strategy,
  stats: { checked: number; closed: number; claimed: number; rebalanced: number }
): Promise<void> {
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
    return
  }

  const entryPriceSol: number = position.entry_price_sol ?? position.metadata?.entry_price_sol ?? 0
  const entryPriceUsd: number = position.entry_price_usd ?? 0

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
  const deployedSol = position.sol_deposited || 0
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

  const rangeLower = position.metadata?.bin_range_down
    ? entryPriceSol * (1 + position.metadata.bin_range_down / 100)
    : 0
  const rangeUpper = position.metadata?.bin_range_up
    ? entryPriceSol * (1 + position.metadata.bin_range_up / 100)
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

// ── Entry point ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[monitor] starting — interval=${MONITOR_INTERVAL_MS / 1000}s`)
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
