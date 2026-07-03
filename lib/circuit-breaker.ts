/**
 * lib/circuit-breaker.ts
 * Daily loss circuit breaker.
 *
 * Computes from local state (closed positions in last 24h).
 * Triggers if >=3 losing closes or cumulative net PnL <= -30% today.
 * This prevents the bot from opening more positions after a bad day.
 * Uses last_net_pnl_pct (set by monitor before close) and sol_deposited for context.
 */
import { getOpenLpPositions } from '@/lib/local-state'

export async function isDailyLossLimitHit(): Promise<boolean> {
  try {
    const positions = getOpenLpPositions()
    const now = Date.now()
    const oneDayMs = 24 * 60 * 60 * 1000

    let lossCount = 0
    let weightedLossSum = 0
    let totalSolDeposited = 0

    for (const p of positions) {
      const status = p.status || ''
      if (!['closed', 'sell_failed'].includes(status) || !p.closed_at) continue
      const closedTs = new Date(p.closed_at).getTime()
      // closed_at is written by markPositionClosed / markPositionSellFailed in persistence.ts (confirmed)
      if (now - closedTs > oneDayMs) continue

      let pnl = Number((p as any).last_net_pnl_pct ?? NaN)
      const solDep = Number((p as any).sol_deposited ?? 0)
      const closeReason: string = (p as any).close_reason ?? ''

      if (status === 'sell_failed') {
        // Stranded token = full loss of the deposited SOL (we swapped it away and couldn't recover)
        pnl = -100
      } else if (!Number.isFinite(pnl) || pnl === 0) {
        // Infer conservative loss when last_net_pnl_pct was never set
        if (closeReason.includes('net_pnl_sl')) {
          const m = closeReason.match(/-?\d+\.?\d*/)
          pnl = m ? parseFloat(m[0]) : -30
        } else if (closeReason.includes('oor')) {
          pnl = -5 // conservative for OOR exits
        } else if (closeReason.includes('max_duration')) {
          pnl = -3
        } else {
          pnl = 0
        }
      }

      if (pnl < 0 && solDep > 0) {
        lossCount++
        weightedLossSum += (pnl / 100) * solDep   // fractional loss in SOL terms
        totalSolDeposited += solDep
      }
    }

    const avgLossPct = totalSolDeposited > 0 ? (weightedLossSum / totalSolDeposited) * 100 : 0
    // Hybrid to prevent large winner diluting small losers: also trigger on any >50% loss + 2+ other losers
    const hasLargeLoser = positions.some(p => {
      if (!['closed', 'sell_failed'].includes(p.status || '') || !p.closed_at) return false
      const pnl = Number((p as any).last_net_pnl_pct ?? 0)
      return pnl <= -50
    })
    const hit = lossCount >= 3 || avgLossPct <= -30 || (hasLargeLoser && lossCount >= 2)
    if (hit) {
      console.log(
        `[circuit-breaker] daily loss limit hit: ${lossCount} losses, weighted avg ${avgLossPct.toFixed(1)}% over last 24h`
      )
    }
    return hit
  } catch (e) {
    console.warn('[circuit-breaker] error computing daily loss, defaulting safe (false):', e)
    return false
  }
}
