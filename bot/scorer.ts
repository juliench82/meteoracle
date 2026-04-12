import type { TokenMetrics } from '@/lib/types'

/**
 * Composite candidate score (0–100).
 *
 * Components:
 *   - Volume/MC ratio    (40pts) — momentum signal
 *   - Rugcheck score     (25pts) — safety signal
 *   - Holder count       (20pts) — distribution signal
 *   - Token freshness    (15pts) — recency signal
 *
 * Bonus (additive, capped at 100 total):
 *   - pump.fun bonding curve 70–95%: +8pts  — sweet spot, about to graduate
 *   - pump.fun bonding curve 95–99%: +4pts  — close but slippage risk
 *   - pump.fun bonding curve 100%:   +5pts  — confirmed graduation = real demand
 *
 * Hard disqualifiers (return 0 immediately):
 *   - pump.fun mint + age < 6h      — too early, classic dump window
 *   - vol/MC ratio > 3.0            — wash trading / imminent dump signal
 */
export function scoreCandidate(token: TokenMetrics): number {
  const isPumpFun = token.address.endsWith('pump')

  if (isPumpFun && token.ageHours < 6) {
    console.log(`[scorer] ${token.symbol} DISQUALIFIED — pump.fun + age ${token.ageHours.toFixed(1)}h < 6h`)
    return 0
  }

  const volMcRatio = token.mcUsd > 0 ? token.volume24h / token.mcUsd : 0

  if (volMcRatio > 3.0) {
    console.log(`[scorer] ${token.symbol} DISQUALIFIED — vol/MC ratio ${volMcRatio.toFixed(2)} > 3.0`)
    return 0
  }

  const volMcScore     = scoreVolumeMcRatio(volMcRatio, isPumpFun)
  const rugScore       = scoreRugcheck(token.rugcheckScore)
  const holderScore    = scoreHolders(token.holderCount)
  const freshnessScore = scoreFreshness(token.ageHours)

  const base = (
    volMcScore     * 0.40 +
    rugScore       * 0.25 +
    holderScore    * 0.20 +
    freshnessScore * 0.15
  )

  let curveBonus = 0
  if (isPumpFun && token.bondingCurvePct !== undefined) {
    const pct = token.bondingCurvePct
    if (pct >= 70 && pct < 95)   curveBonus = 8
    else if (pct >= 95 && pct < 100) curveBonus = 4
    else if (pct === 100)         curveBonus = 5  // confirmed graduation
  }

  const total = base + curveBonus

  if (curveBonus > 0) {
    console.log(`[scorer] ${token.symbol} curve bonus +${curveBonus} (curve=${token.bondingCurvePct?.toFixed(1)}%)`)
  }

  return Math.round(Math.min(100, Math.max(0, total)))
}

function scoreVolumeMcRatio(ratio: number, isPumpFun: boolean): number {
  const effectiveRatio = isPumpFun ? Math.min(ratio, 1.5) : ratio
  const penalty        = isPumpFun ? 15 : 0

  let base: number
  if (effectiveRatio >= 2.0)       base = 100
  else if (effectiveRatio >= 1.0)  base = 90
  else if (effectiveRatio >= 0.5)  base = 75
  else if (effectiveRatio >= 0.2)  base = 55
  else if (effectiveRatio >= 0.1)  base = 35
  else if (effectiveRatio >= 0.05) base = 15
  else base = 0

  return Math.max(0, base - penalty)
}

function scoreRugcheck(rugcheckScore: number): number {
  if (rugcheckScore >= 90) return 100
  if (rugcheckScore >= 80) return 85
  if (rugcheckScore >= 70) return 70
  if (rugcheckScore >= 60) return 50
  if (rugcheckScore >= 50) return 30
  return 10
}

function scoreHolders(holderCount: number): number {
  if (holderCount >= 5000) return 100
  if (holderCount >= 2000) return 80
  if (holderCount >= 1000) return 65
  if (holderCount >= 500)  return 45
  if (holderCount >= 200)  return 25
  return 10
}

function scoreFreshness(ageHours: number): number {
  if (ageHours <= 1)  return 100
  if (ageHours <= 3)  return 90
  if (ageHours <= 6)  return 75
  if (ageHours <= 12) return 55
  if (ageHours <= 24) return 35
  if (ageHours <= 48) return 15
  return 5
}
