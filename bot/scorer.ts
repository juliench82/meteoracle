import type { TokenMetrics } from '@/lib/types'

/**
 * Composite candidate score (0–100).
 *
 * Components:
 *   - Volume/MC ratio (40pts)  — momentum signal: how much is trading vs market cap
 *   - Rugcheck score   (25pts) — safety signal
 *   - Holder count     (20pts) — distribution signal
 *   - Token freshness  (15pts) — recency signal (fresher = higher priority)
 */
export function scoreCandidate(token: TokenMetrics): number {
  const volMcScore = scoreVolumeMcRatio(token.volume24h, token.mcUsd)
  const rugScore = scoreRugcheck(token.rugcheckScore)
  const holderScore = scoreHolders(token.holderCount)
  const freshnessScore = scoreFreshness(token.ageHours)

  const total = (
    volMcScore * 0.40 +
    rugScore   * 0.25 +
    holderScore * 0.20 +
    freshnessScore * 0.15
  )

  return Math.round(Math.min(100, Math.max(0, total)))
}

// ---------------------------------------------------------------------------
// Component scorers (each returns 0–100)
// ---------------------------------------------------------------------------

/**
 * Volume/MC ratio — the core momentum signal.
 * A ratio of 1.0 (volume = MC) is exceptional. 0.1+ is active. < 0.05 is weak.
 */
function scoreVolumeMcRatio(volume24h: number, mcUsd: number): number {
  if (mcUsd <= 0) return 0
  const ratio = volume24h / mcUsd

  if (ratio >= 2.0)  return 100  // volume > 2x MC — extreme activity
  if (ratio >= 1.0)  return 90   // volume = MC — very high
  if (ratio >= 0.5)  return 75   // 50% vol/MC — strong
  if (ratio >= 0.2)  return 55   // 20% vol/MC — decent
  if (ratio >= 0.1)  return 35   // 10% vol/MC — weak but present
  if (ratio >= 0.05) return 15   // marginal
  return 0
}

/**
 * Rugcheck score — rugcheck.xyz returns 0–100.
 * We penalise anything below 60 heavily.
 */
function scoreRugcheck(rugcheckScore: number): number {
  if (rugcheckScore >= 90) return 100
  if (rugcheckScore >= 80) return 85
  if (rugcheckScore >= 70) return 70
  if (rugcheckScore >= 60) return 50
  if (rugcheckScore >= 50) return 30
  return 10
}

/**
 * Holder count — more unique holders = better distribution.
 * Caps at 5,000 holders for max score.
 */
function scoreHolders(holderCount: number): number {
  if (holderCount >= 5000) return 100
  if (holderCount >= 2000) return 80
  if (holderCount >= 1000) return 65
  if (holderCount >= 500)  return 45
  if (holderCount >= 200)  return 25
  return 10
}

/**
 * Freshness — penalise older tokens.
 * Scalp Spike needs tokens < 6h old. Evil Panda works up to 72h.
 */
function scoreFreshness(ageHours: number): number {
  if (ageHours <= 1)  return 100  // just launched
  if (ageHours <= 3)  return 90
  if (ageHours <= 6)  return 75
  if (ageHours <= 12) return 55
  if (ageHours <= 24) return 35
  if (ageHours <= 48) return 15
  return 5
}
