/**
 * lib/fee-tvl-exit-rule.ts
 *
 * Pure predicate for monitor exit rule #1 — "Fee/TVL yield collapse".
 *
 * Extracted verbatim from bot/monitor.ts so the rule can be unit-tested
 * without the on-chain / RPC dependency chain.  Behaviour is byte-identical
 * to the historical inline condition:
 *
 *   const minSamplesRequired = positionAgeHours > 1 ? 5 : 10
 *   fire = feeTvl4hAvg != null && feeTvl4hAvg < thresholdPct
 *          && sampleCount >= minSamplesRequired
 *
 * Units: `feeTvl4hAvg` and `thresholdPct` are PERCENT (the API's own unit —
 * see getFeeTvlPct in bot/scanner/pool-metrics.ts).  The roll-up of the
 * samples happens in the caller; this module only decides.
 */

export interface FeeTvlExitRuleInput {
  /** Rolling average of the position pool's 24h Fee/TVL % samples, or null when unsampled. */
  feeTvl4hAvg: number | null
  /** Number of samples inside the rolling window. */
  sampleCount: number
  /** Position age in hours (drives the minimum-sample requirement). */
  positionAgeHours: number
  /** Shipped exit threshold, percent. */
  thresholdPct: number
  /** Minimum samples for a position older than 1h (default 5). */
  minSamplesOldPosition?: number
  /** Minimum samples for a position <= 1h old (default 10). */
  minSamplesYoungPosition?: number
}

export interface FeeTvlExitRuleResult {
  fire: boolean
  reason: string | null
}

export function evaluateFeeTvlCollapseRule(input: FeeTvlExitRuleInput): FeeTvlExitRuleResult {
  const {
    feeTvl4hAvg,
    sampleCount,
    positionAgeHours,
    thresholdPct,
    minSamplesOldPosition = 5,
    minSamplesYoungPosition = 10,
  } = input

  if (feeTvl4hAvg == null || !Number.isFinite(feeTvl4hAvg)) {
    return { fire: false, reason: null }
  }

  const minSamplesRequired = positionAgeHours > 1 ? minSamplesOldPosition : minSamplesYoungPosition
  if (sampleCount < minSamplesRequired) {
    return { fire: false, reason: null }
  }

  if (feeTvl4hAvg >= thresholdPct) {
    return { fire: false, reason: null }
  }

  return { fire: true, reason: `fee_tvl_yield_low_4havg_${feeTvl4hAvg.toFixed(2)}pct` }
}