import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'
import { getBotState } from '@/lib/botState'
import { closePosition, openPosition } from '@/bot/executor'
import { closePreGradPosition } from '@/lib/pre-grad'
import { sendAlert } from '@/bot/alerter'
import { detectAllOrphanedPositions } from '@/bot/orphan-detector'
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

// Run full-wallet orphan scan every N ticks (default 15 ≈ 15 min at 60s interval)
const ORPHAN_CHECK_EVERY_N = parseInt(process.env.ORPHAN_CHECK_EVERY_N ?? '15')
let tickCount = 0

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

  tickCount++
  if (tickCount % ORPHAN_CHECK_EVERY_N === 0) {
    console.log(`[monitor] tick ${tickCount} — running auto orphan scan`)
    try {
      await detectAllOrphanedPositions()
    } catch (err) {
      console.warn('[monitor] auto orphan scan failed (non-fatal):', err)
    }
  }

  console.log('[monitor] fetching open LP positions')
  let positions: any[]
  try {
    positions = await sbSelect('lp_positions', 'status=in.(active,open,out_of_range)&order=opened_at.desc')
  } catch (err) {
    console.warn('[monitor] lp_positions fetch error:', err)
    return stats
  }

  if (!positions.length) { console.log('[monitor] no open LP positions'); return stats }
  console.log(`[monitor] checking ${positions.length} LP positions`)

  for (const position of positions) {
    try {
      stats.checked++

      // Pre-grad DAMM v2 positions — routed to their own close handler
      if (position.position_type === 'pre_grad') {
        const closed = await closePreGradPosition(position)
        if (closed) stats.closed++
        continue
      }

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

  const { inRange, currentPriceSol, feesEarnedSol, volume1hUsd, externallyClosed } = await fetchPositionState(
    position.pool_address,
    position.position_pubkey
  )

  if (externallyClosed) {
    console.warn(`${label} position missing on-chain — marking closed in DB`)
    try {
      await sbUpdate('lp_positions', `id=eq.${position.id}`, {
        status: 'closed',
        closed_at: new Date().toISOString(),
        in_range: false,
        oor_since_at: null,
        close_reason: 'external_close_detected',
        fees_earned_sol: feesEarnedSol,
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

  const pnlSol = entryPriceSol > 0
    ? Math.round((position.sol_deposited * (pricePct / 100) + feesEarnedSol) * 1e6) / 1e6
    : Math.round(feesEarnedSol * 1e6) / 1e6

  // USD values derived from entry price ratio (best available without live oracle)
  const solPriceUsd = entryPriceSol > 0 && entryPriceUsd > 0
    ? entryPriceUsd / entryPriceSol
    : 0
  const claimableFeesUsd = solPriceUsd > 0
    ? Math.round(feesEarnedSol * solPriceUsd * 100) / 100
    : null
  const positionValueUsd = solPriceUsd > 0
    ? Math.round((position.sol_deposited + pnlSol) * solPriceUsd * 100) / 100
    : null

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
      current_price:     currentPriceSol,
      in_range:          inRange,
      fees_earned_sol:   feesEarnedSol,
      il_pct:            ilPct,
      pnl_sol:           pnlSol,
      status:            inRange ? 'active' : 'out_of_range',
      oor_since_at:      oorSinceAt,
      ...(claimableFeesUsd !== null  ? { claimable_fees_usd:  claimableFeesUsd }  : {}),
      ...(positionValueUsd !== null  ? { position_value_usd:  positionValueUsd }  : {}),
    })
  } catch (err) {
    console.error(`${label} DB update failed:`, err)
  }

  const openedAt = new Date(position.opened_at).getTime()
  const ageHours = (now - openedAt) / (1000 * 60 * 60)
  const oorSince = !inRange && oorSinceAt
    ? (now - new Date(oorSinceAt).getTime()) / 60_000
    : 0

  const deployedSol = position.sol_deposited || 0
  const feeYieldPct = deployedSol > 0 ? (feesEarnedSol / deployedSol) * 100 : 0

  console.log(
    `${label} inRange=${inRange} price=${currentPriceSol.toFixed(9)} entry=${entryPriceSol.toFixed(9)}` +
    ` pnl=${pnlSol.toFixed(6)} fees=${feeYieldPct.toFixed(1)}%deployed` +
    ` claimable=$${claimableFeesUsd ?? 'n/a'} posValue=$${positionValueUsd ?? 'n/a'}` +
    ` age=${ageHours.toFixed(1)}h oorMin=${oorSince.toFixed(0)}`
  )

  // === EXIT LOGIC ===
  let closeReason: string | null = null

  if (!inRange && oorSince >= strategy.exits.outOfRangeMinutes) {
    closeReason = `out_of_range_${Math.round(oorSince)}min`
  } else if (entryPriceSol > 0 && pricePct <= strategy.exits.stopLossPct) {
    closeReason = `stoploss_${pricePct.toFixed(1)}pct`
  } else if (entryPriceSol > 0 && pricePct >= strategy.exits.takeProfitPct) {
    closeReason = `takeprofit_${pricePct.toFixed(1)}pct`
  } else if (ageHours >= strategy.exits.maxDurationHours) {
    closeReason = `max_duration_${Math.round(ageHours)}h`
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
    const driftedLowInRange = positionInRange < (50 - SMART_REBALANCE_THRESHOLD_PCT / 2)

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
              mcUsd: 0,
              volume24h: 0,
              liquidityUsd: 0,
              topHolderPct: 0,
              holderCount: 0,
              ageHours,
              rugcheckScore: 0,
              feeTvl24hPct: 0,
            }
            await openPosition(metrics, strategy)
            console.log(`${label} reopened centered at ${currentPriceSol}`)
          } catch (reopenErr) {
            console.error(`${label} reopen after rebalance failed:`, reopenErr)
          }
        }
      }
    }
  }
}

async function fetchPositionState(
  poolAddress: string,
  positionPubKey: string
): Promise<{ inRange: boolean; currentPriceSol: number; feesEarnedSol: number; volume1hUsd: number; externallyClosed: boolean }> {
  const connection = getConnection()
  const DLMM = await getDLMM()

  try {
    const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
    const activeBin = await dlmmPool.getActiveBin()
    const currentPriceSol = parseFloat(activeBin.pricePerToken)

    const wallet = getWallet()
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey)
    const pos = userPositions.find(p => p.publicKey.toBase58() === positionPubKey)

    if (!pos) return { inRange: false, currentPriceSol, feesEarnedSol: 0, volume1hUsd: 0, externallyClosed: true }

    const posData = pos.positionData
    const activeBinId = activeBin.binId
    const inRange = activeBinId >= posData.lowerBinId && activeBinId <= posData.upperBinId

    const feeX = Number(posData.feeX ?? 0) / 1e9
    const feeY = Number(posData.feeY ?? 0) / 1e9
    const feesEarnedSol = feeX + feeY

    // NOTE: volume1hUsd intentionally set to 0 — the undocumented
    // dlmm-api.meteora.ag endpoint is rate-limited and not part of any
    // official Meteora API. Will be replaced with the official
    // DAMM v2 / DLMM API once endpoints are confirmed.
    const volume1hUsd = 0

    return { inRange, currentPriceSol, feesEarnedSol, volume1hUsd, externallyClosed: false }
  } catch (err) {
    console.error(`[fetchPositionState] error for pool ${poolAddress}:`, err)
    return { inRange: false, currentPriceSol: 0, feesEarnedSol: 0, volume1hUsd: 0, externallyClosed: false }
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

main().catch(err => {
  console.error('[monitor] fatal startup error:', err)
  process.exit(1)
})
