/**
 * lib/stop-loss-rule.ts
 *
 * Pure Net-PnL stop-loss predicate used by bot/monitor.ts.
 *
 * Context (G6): the regular -30% net-PnL SL is gated behind
 * LP_NET_LOSS_SL_MIN_AGE_MIN (20 min). During that warm-up window a position had
 * NO stop-loss at all — so it could lose >50% before the regular rule was even
 * allowed to fire. This adds a TIGHTER interim SL (LP_NET_LOSS_SL_INTERIM_PCT,
 * default -15%) that is active ONLY during warm-up (ageMin < graceMin).
 *
 * The Fee/TVL warm-up rule itself (lib/fee-tvl-exit-rule.ts, monitor.ts:207-235)
 * is untouched — only the net-PnL SL is tightened.
 */
export interface StopLossInput {
  ageMin: number
  netPnl: number | null
  graceMin: number
  interimPct: number
  regularPct: number
}

export type StopLossRule = 'interim' | 'regular' | null

export interface StopLossResult {
  fire: boolean
  reason: string | null
  rule: StopLossRule
}

export function evaluateNetPnLStopLoss(i: StopLossInput): StopLossResult {
  if (i.netPnl == null) {
    return { fire: false, reason: null, rule: null }
  }

  // Warm-up window (position younger than the grace period): tighter interim SL.
  if (i.ageMin < i.graceMin && i.netPnl <= i.interimPct) {
    return {
      fire: true,
      reason: `net_pnl_interim_sl_${i.netPnl.toFixed(1)}pct`,
      rule: 'interim',
    }
  }

  // After grace: the regular (-30%) SL. Note interimPct (-15) is tighter than
  // regularPct (-30), so a value between them is intentionally NOT a stop here.
  if (i.ageMin >= i.graceMin && i.netPnl <= i.regularPct) {
    return {
      fire: true,
      reason: `net_pnl_sl_${i.netPnl.toFixed(1)}pct`,
      rule: 'regular',
    }
  }

  return { fire: false, reason: null, rule: null }
}
