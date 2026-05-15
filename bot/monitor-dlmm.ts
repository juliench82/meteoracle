import { closePosition } from './executor'
import { sendAlert } from './alerter'
import { fetchPositionState } from './monitor-core'
import { firstNumber, nullableNumber, roundMoney, roundPct, resolveMeteoraPnlPct } from './monitor-core'

// All DLMM exit logic extracted from monitor.ts — exact copy, no loss.

export async function checkDlmmPosition(
  position: any,
  strategy: any,
  stats: { checked: number; closed: number; claimed: number; rebalanced: number },
  liveSolPriceUsd: number | null,
): Promise<void> {
  const label = `[monitor][${position.symbol}][${strategy.id}]`
  const now = Date.now()

  let inRange = position.in_range !== false
  let currentPriceSol = position.current_price || 0
  let claimableFeesSolEquivalent = 0
  let externallyClosed = false

  const hasLivePrice = typeof position.current_price === 'number' && position.current_price > 0
  const hasLiveFees = position.claimable_fees_usd != null

  if (!hasLivePrice || !hasLiveFees) {
    // Fallback to direct on-chain read (rare now that merge + sync provide live data)
    const state = await fetchPositionState(position.pool_address, position.position_pubkey)
    if (!state.ok) {
      console.warn(`${label} position state read failed — skipping exit checks this tick`)
      return
    }
    inRange = state.inRange
    currentPriceSol = state.currentPriceSol
    claimableFeesSolEquivalent = state.claimableFeesSolEquivalent
    externallyClosed = state.externallyClosed
  } else {
    inRange = position.in_range !== false
    currentPriceSol = position.current_price
    const solPrice = liveSolPriceUsd ?? firstNumber(position.metadata?.sol_price_usd, position.metadata?.current_sol_price_usd) ?? 0
    claimableFeesSolEquivalent = solPrice > 0 ? (position.claimable_fees_usd ?? 0) / solPrice : 0
  }

  if (externallyClosed) {
    console.warn(`${label} position missing on-chain — marking closed in DB`)
    stats.closed++
    return
  }

  if (currentPriceSol === 0) {
    console.warn(`${label} price read returned 0 — RPC fallback hit, skipping tick`)
    return
  }

  const entryPriceSol = firstNumber(position.entry_price_sol, position.metadata?.entry_price_sol) ?? 0
  const pricePct = entryPriceSol > 0 ? ((currentPriceSol - entryPriceSol) / entryPriceSol) * 100 : 0

  const ilPct: number | null = entryPriceSol > 0 && currentPriceSol > 0
    ? (() => {
        const k = currentPriceSol / entryPriceSol
        return Math.round((2 * Math.sqrt(k) / (1 + k) - 1) * 10000) / 100
      })()
    : null

  const solPriceUsd = liveSolPriceUsd ?? firstNumber(position.metadata?.sol_price_usd, position.metadata?.current_sol_price_usd)
  const derivedClaimableFeesUsd = solPriceUsd !== null ? roundMoney(claimableFeesSolEquivalent * solPriceUsd) : null
  const liveClaimableFeesUsd = nullableNumber(position.claimable_fees_usd ?? position.metadata?.claimable_fees_usd)
  const livePositionValueUsd = nullableNumber(position.position_value_usd ?? position.metadata?.position_value_usd)
  const livePnlUsd = firstNumber(position.pnl_usd, position.metadata?.pnl_usd, position.metadata?.position_pnl_usd, position.metadata?.total_pnl_usd)
  const claimableFeesUsd = liveClaimableFeesUsd ?? derivedClaimableFeesUsd
  const positionValueUsd = livePositionValueUsd
  const deployedSol = firstNumber(position.sol_deposited) ?? 0
  const pnlPct = resolveMeteoraPnlPct(position, livePnlUsd, deployedSol, liveSolPriceUsd)
  const previousNullPnlTicks = Math.max(0, Math.trunc(nullableNumber(position.null_pnl_ticks) ?? 0))
  const currentNullPnlTicks = pnlPct === null ? previousNullPnlTicks + 1 : 0

  const wasInRange = position.status !== 'out_of_range' && position.in_range !== false
  const justWentOOR = !inRange && wasInRange
  const oorSinceAt: string | null = justWentOOR ? new Date().toISOString() : (!inRange ? (position.oor_since_at ?? new Date().toISOString()) : null)

  try {
    await (await import('./monitor-core')).sbUpdate('lp_positions', `id=eq.${position.id}`, {
      current_price: currentPriceSol,
      in_range: inRange,
      il_pct: ilPct,
      status: inRange ? 'active' : 'out_of_range',
      oor_since_at: oorSinceAt,
      ...(claimableFeesUsd !== null ? { claimable_fees_usd: claimableFeesUsd } : {}),
      ...(positionValueUsd !== null ? { position_value_usd: positionValueUsd } : {}),
      ...(livePnlUsd !== null ? { pnl_usd: livePnlUsd } : {}),
      null_pnl_ticks: currentNullPnlTicks,
    })
  } catch (err) {
    console.error(`${label} DB update failed:`, err)
  }

  if (justWentOOR) {
    await sendAlert({ type: 'position_oor', symbol: position.symbol, strategy: strategy.id, currentPrice: currentPriceSol, binRangeLower: 0, binRangeUpper: 0, oorExitMinutes: strategy.exits?.outOfRangeMinutes ?? 0 })
  }

  const openedAt = new Date(position.opened_at).getTime()
  const ageHours = (now - openedAt) / (1000 * 60 * 60)
  const oorSince = !inRange && oorSinceAt ? (now - new Date(oorSinceAt).getTime()) / 60_000 : 0

  console.log(`${label} inRange=${inRange} price=${currentPriceSol.toFixed(9)} entry=${entryPriceSol.toFixed(9)} pnlPct=${pnlPct !== null ? `${pnlPct.toFixed(2)}%` : 'n/a'} ilPct=${ilPct !== null ? `${ilPct.toFixed(2)}%` : 'n/a'} age=${ageHours.toFixed(1)}h`)

  let closeReason: string | null = null

  if (strategy.exits.maxIlPct !== undefined && ilPct !== null && ilPct <= strategy.exits.maxIlPct) {
    closeReason = `il_exit_${ilPct.toFixed(2)}pct`
  } else if (pnlPct !== null && pnlPct <= strategy.exits.stopLossPct) {
    closeReason = `stoploss_pnl_${pnlPct.toFixed(1)}pct`
  } else if (pnlPct !== null && pnlPct >= strategy.exits.takeProfitPct) {
    closeReason = `takeprofit_pnl_${pnlPct.toFixed(1)}pct`
  } else if (ageHours >= strategy.exits.maxDurationHours) {
    closeReason = `max_duration_${Math.round(ageHours)}h`
  } else if (currentNullPnlTicks >= 10) {
    closeReason = `pnl_unavailable_10ticks`
  } else if (!inRange && oorSince >= strategy.exits.outOfRangeMinutes) {
    closeReason = `out_of_range_${Math.round(oorSince)}min`
  } else if (pnlPct === null) {
    if (currentNullPnlTicks >= 3) {
      // P2: throttle PnL unavailable alerts to reduce noise on free tiers
      const shouldAlert = currentNullPnlTicks === 3 || currentNullPnlTicks % 6 === 0
      if (shouldAlert) {
        await sendAlert({ type: 'pnl_unavailable_warning', symbol: position.symbol, strategy: strategy.id, positionId: position.id, reason: `pnl_unavailable_${currentNullPnlTicks}ticks`, ageHours: Math.round(ageHours * 10) / 10 })
      }
      console.warn(`${label} DLMM PnL unavailable ${currentNullPnlTicks} consecutive ticks`)
    }
  }

  if (!closeReason) return

  console.log(`${label} EXIT triggered → ${closeReason}`)
  const closed = await closePosition(position.id, closeReason)
  if (closed) {
    stats.closed++
    await sendAlert({ type: 'position_closed', symbol: position.symbol, strategy: strategy.id, reason: closeReason, claimableFeesUsd: claimableFeesUsd ?? undefined, ilPct, ageHours: Math.round(ageHours * 10) / 10 })
  } else {
    console.warn(`${label} close skipped or failed`)
  }
}
