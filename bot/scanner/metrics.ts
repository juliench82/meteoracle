import type { TokenMetrics } from '@/lib/types'
import { scoreCandidateWithBreakdown } from '../scorer'
import { EVIL_PANDA_SCANNER_SCORE_WEIGHTS } from '@/strategies/evil-panda'
import { scalpSpikeStrategy } from '@/strategies/scalp-spike'

export function scoreFeeTvl1hPct(pct: number): number {
  if (pct >= 8) return 100
  if (pct >= 5) return 85
  if (pct >= 3) return 65
  if (pct >= 1.5) return 40
  if (pct >= 0.5) return 20
  return 0
}

export function scoreVolumeTvl1hRatio(ratio: number): number {
  if (ratio >= 1.5) return 100
  if (ratio >= 1.0) return 90
  if (ratio >= 0.5) return 75
  if (ratio >= 0.2) return 55
  if (ratio >= 0.1) return 30
  return 0
}

export function scoreHolderCount(holderCount: number): number {
  if (holderCount >= 5000) return 100
  if (holderCount >= 2000) return 80
  if (holderCount >= 1000) return 65
  if (holderCount >= 500) return 45
  if (holderCount >= 200) return 25
  return 10
}

export function getMomentumRegainBreakdown(
  metrics: TokenMetrics,
): ReturnType<typeof scoreCandidateWithBreakdown> {
  const rugScore = Math.max(0, Math.min(100, metrics.rugcheckScore))
  const holderScore = scoreHolderCount(metrics.holderCount)
  const feeEfficiencyScore = scoreFeeTvl1hPct(metrics.feeTvl1hPct ?? 0)
  const volumeTvlScore = scoreVolumeTvl1hRatio(metrics.volumeTvl1hRatio ?? 0)
  const freshnessScore =
    metrics.ageHours <= 6 ? 100 :
    metrics.ageHours <= 12 ? 85 :
    metrics.ageHours <= 24 ? 70 :
    55
  const total = Math.round(
    Math.min(
      100,
      feeEfficiencyScore * 0.35 +
      volumeTvlScore * 0.35 +
      rugScore * 0.15 +
      holderScore * 0.10 +
      freshnessScore * 0.05,
    ),
  )

  return {
    total,
    volMcScore: 0,
    rugScore,
    holderScore,
    freshnessScore,
    feeEfficiencyScore,
    volumeTvlScore,
    curveBonus: 0,
  }
}

export function getScannerAdjustedScore(
  metrics: TokenMetrics,
  strategyId: string,
  breakdown: ReturnType<typeof scoreCandidateWithBreakdown>,
): number {
  if (strategyId !== 'evil-panda') return breakdown.total

  const weights = EVIL_PANDA_SCANNER_SCORE_WEIGHTS
  const totalWeight =
    weights.freshness +
    weights.rugcheck +
    weights.holders +
    weights.feeTvl1h +
    weights.volumeTvl1h

  if (totalWeight <= 0) return breakdown.total

  const feeTvl1hScore = scoreFeeTvl1hPct(metrics.feeTvl1hPct ?? 0)
  const volumeTvl1hScore = scoreVolumeTvl1hRatio(metrics.volumeTvl1hRatio ?? 0)
  const weighted =
    (breakdown.freshnessScore * weights.freshness +
      breakdown.rugScore * weights.rugcheck +
      breakdown.holderScore * weights.holders +
      feeTvl1hScore * weights.feeTvl1h +
      volumeTvl1hScore * weights.volumeTvl1h) / totalWeight

  const total = Math.round(Math.min(100, Math.max(0, weighted + breakdown.curveBonus)))
  console.log(
    `[scanner] ${metrics.symbol} — evil-panda weighted score ` +
    `fee1h=${feeTvl1hScore} volTvl1h=${volumeTvl1hScore} raw=${breakdown.total} → ${total}`,
  )
  return total
}

export function passesMomentumRegainStrategyFilters(metrics: TokenMetrics): boolean {
  const f = scalpSpikeStrategy.filters
  return (
    scalpSpikeStrategy.enabled &&
    metrics.mcUsd >= f.minMcUsd &&
    metrics.mcUsd <= f.maxMcUsd &&
    metrics.liquidityUsd >= f.minLiquidityUsd &&
    metrics.topHolderPct <= f.maxTopHolderPct &&
    metrics.holderCount >= f.minHolderCount &&
    metrics.ageHours <= f.maxAgeHours &&
    metrics.rugcheckScore >= f.minRugcheckScore &&
    metrics.feeTvl24hPct >= f.minFeeTvl24hPct
  )
}
