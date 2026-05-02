import type { TokenMetrics, Strategy } from '@/lib/types'

/**
 * Composite candidate score (0–100).
 *
 * Components:
 *   - Volume/MC ratio       (25pts) - broad momentum signal
 *   - Rugcheck score        (15pts) - safety signal (raw: candidates.rugcheck_score)
 *   - Holder count          (15pts) - distribution signal
 *   - Token freshness       (20pts) - recency signal
 *   - Recent Fee/TVL        (15pts) - Meteora-native 1h/5m fee efficiency
 *   - Recent volume / TVL   (10pts) - hot-pool efficiency + acceleration
 *
 * Freshness is tier-aware:
 *   - SHITCOIN (Evil Panda):  rewards very fresh tokens (<24h)
 *   - MEMECOIN (Scalp Spike): rewards established tokens (72h–120h gets full score)
 *   - LARGE_CAP (Stable Farm): age is irrelevant, always max freshness score
 *
 * Bonus (additive, capped at 100 total):
 *   - pump.fun bonding curve 70–95%: +8pts
 *   - pump.fun bonding curve 95–99%: +4pts
 *   - pump.fun bonding curve 100%:   +5pts
 *
 * Hard disqualifiers:
 *   - pump.fun mint + age < 6h      — too early, classic dump window
 *   - vol/MC ratio > 3.0            — wash trading signal
 *   - feeTvl24hPct < strategy.filters.minFeeTvl24hPct — pool not hot enough for this strategy
 */

export interface ScoreBreakdown {
  total:          number
  volMcScore:     number
  rugScore:       number
  holderScore:    number
  freshnessScore: number
  feeEfficiencyScore: number
  volumeTvlScore: number
  curveBonus:     number
}

export function scoreCandidate(token: TokenMetrics, strategy: Strategy): number {
  return scoreCandidateWithBreakdown(token, strategy).total
}

export function scoreCandidateWithBreakdown(token: TokenMetrics, strategy: Strategy): ScoreBreakdown {
  const zero = (reason: string): ScoreBreakdown => {
    console.log(`[scorer] ${token.symbol} DISQUALIFIED — ${reason}`)
    return {
      total: 0,
      volMcScore: 0,
      rugScore: 0,
      holderScore: 0,
      freshnessScore: 0,
      feeEfficiencyScore: 0,
      volumeTvlScore: 0,
      curveBonus: 0,
    }
  }

  const isPumpFun = token.address.endsWith('pump')

  if (isPumpFun && token.ageHours < 6)
    return zero(`pump.fun + age ${token.ageHours.toFixed(1)}h < 6h`)

  const volMcRatio = token.mcUsd > 0 ? token.volume24h / token.mcUsd : 0

  if (volMcRatio > 3.0)
    return zero(`vol/MC ratio ${volMcRatio.toFixed(2)} > 3.0`)

  if (token.feeTvl24hPct < strategy.filters.minFeeTvl24hPct)
    return zero(`feeTvl24hPct ${token.feeTvl24hPct.toFixed(2)}% < required ${strategy.filters.minFeeTvl24hPct}% for ${strategy.id}`)

  const isLargeCap = token.mcUsd >= 10_000_000 && token.liquidityUsd >= 500_000
  const isMemecoin = !isLargeCap && token.mcUsd >= 5_000_000 && token.ageHours >= 72

  const rugScore     = scoreRugcheck(token.rugcheckScore)
  const volMcScore   = scoreVolumeMcRatio(volMcRatio, isPumpFun)
  const holderScore  = scoreHolders(token.holderCount)
  const freshnessScore = scoreFreshness(token.ageHours, isLargeCap, isMemecoin)
  const feeEfficiencyScore = scoreFeeEfficiency(token)
  const volumeTvlScore = scoreRecentVolumeEfficiency(token)

  const base = (
    volMcScore          * 0.25 +
    rugScore            * 0.15 +
    holderScore         * 0.15 +
    freshnessScore      * 0.20 +
    feeEfficiencyScore  * 0.15 +
    volumeTvlScore      * 0.10
  )

  let curveBonus = 0
  if (isPumpFun && token.bondingCurvePct !== undefined) {
    const pct = token.bondingCurvePct
    if (pct >= 70 && pct < 95)       curveBonus = 8
    else if (pct >= 95 && pct < 100) curveBonus = 4
    else if (pct === 100)            curveBonus = 5
  }

  const total = Math.round(Math.min(100, Math.max(0, base + curveBonus)))

  console.log(
    `[scorer] ${token.symbol} — ` +
    `volMc=${volMcScore.toFixed(0)} rug=${rugScore.toFixed(0)} ` +
    `holders=${holderScore.toFixed(0)} fresh=${freshnessScore.toFixed(0)} ` +
    `feeEff=${feeEfficiencyScore.toFixed(0)} volTvl=${volumeTvlScore.toFixed(0)} ` +
    `bonus=${curveBonus} → ${total}`
  )

  return {
    total,
    volMcScore,
    rugScore,
    holderScore,
    freshnessScore,
    feeEfficiencyScore,
    volumeTvlScore,
    curveBonus,
  }
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

function scoreFeeEfficiency(token: TokenMetrics): number {
  const feeTvl1hPct = token.feeTvl1hPct ?? 0
  const feeTvl5mPct = (token.feeTvl5mPct ?? 0) * 6
  const feeTvl24hHourlyPct = token.feeTvl24hPct / 12
  const recentFeePct = Math.max(feeTvl1hPct, feeTvl5mPct, feeTvl24hHourlyPct)

  if (recentFeePct >= 8) return 100
  if (recentFeePct >= 5) return 85
  if (recentFeePct >= 3) return 65
  if (recentFeePct >= 1.5) return 40
  if (recentFeePct >= 0.5) return 20
  return 0
}

function scoreRecentVolumeEfficiency(token: TokenMetrics): number {
  const ratio = token.volumeTvl1hRatio ?? (
    token.volume1h !== undefined && token.liquidityUsd > 0 ? token.volume1h / token.liquidityUsd : 0
  )
  const growth = token.volumeGrowth1h ?? 0

  let base: number
  if (ratio >= 1.0)       base = 90
  else if (ratio >= 0.5)  base = 75
  else if (ratio >= 0.2)  base = 55
  else if (ratio >= 0.1)  base = 30
  else if (ratio >= 0.05) base = 15
  else base = 0

  const growthBonus = growth >= 2.5 ? 10 : growth >= 1.5 ? 7 : growth >= 1 ? 4 : 0
  return Math.min(100, base + growthBonus)
}

/**
 * Tier-aware freshness scoring:
 * - Large cap (Stable Farm): age irrelevant → always 100
 * - Memecoin (Scalp Spike):  72–120h is the sweet spot → 100; penalise very fresh
 * - Shitcoin (Evil Panda):   very fresh is best → original curve
 */
function scoreFreshness(ageHours: number, isLargeCap: boolean, isMemecoin: boolean): number {
  if (isLargeCap) return 100

  if (isMemecoin) {
    if (ageHours >= 72 && ageHours <= 120) return 100
    if (ageHours >= 48 && ageHours < 72)   return 80
    if (ageHours >= 24 && ageHours < 48)   return 60
    if (ageHours < 24)                     return 30
    return 50
  }

  if (ageHours <= 1)  return 100
  if (ageHours <= 3)  return 90
  if (ageHours <= 6)  return 75
  if (ageHours <= 12) return 55
  if (ageHours <= 24) return 35
  if (ageHours <= 48) return 15
  return 5
}
