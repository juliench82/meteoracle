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
    let totalLossPct = 0

    for (const p of positions) {
      if (p.status !== 'closed' || !p.closed_at) continue
      const closedTs = new Date(p.closed_at).getTime()
      if (now - closedTs > oneDayMs) continue

      const pnl = (p as any).last_net_pnl_pct ?? 0
      if (pnl < 0) {
        lossCount++
        totalLossPct += pnl
      }
    }

    const hit = lossCount >= 3 || totalLossPct <= -30
    if (hit) {
      console.log(
        `[circuit-breaker] daily loss limit hit: ${lossCount} losses, cumulative ${totalLossPct.toFixed(1)}% over last 24h`
      )
    }
    return hit
  } catch (e) {
    console.warn('[circuit-breaker] error computing daily loss, defaulting safe (false):', e)
    return false
  }
}
