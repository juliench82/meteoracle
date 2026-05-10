import type { TokenMetrics } from '@/lib/types'

/**
 * Moonboy Strategy
 * Loose-filter spot buy for fresh tokens that have already passed LP strategy selection and successful open.
 * Triggered ONLY post-LP success to ensure quality pre-filter (kills standalone loose scanner triggers).
 * Exit: +100% TP, -50% SL, 6h max hold (handled in monitor).
 */
export const moonboyStrategy = {
  id: 'moonboy',
  name: 'Moonboy',
  description: 'Loose criteria spot buy on fresh tokens post-LP confirmation. High risk/high reward flip.',
  enabled: true,
  filters: {
    minMcUsd: 0,
    maxMcUsd: 1_000_000_000,
    minVolume24h: 0,
    minLiquidityUsd: 500,
    maxTopHolderPct: 80,
    minHolderCount: 0,
    maxAgeHours: 1.5,
    minRugcheckScore: 0,
  },
}

export function isMoonboyEligible(metrics: TokenMetrics): boolean {
  const f = moonboyStrategy.filters
  return (
    metrics.ageHours <= f.maxAgeHours &&
    metrics.liquidityUsd >= f.minLiquidityUsd &&
    metrics.topHolderPct <= f.maxTopHolderPct &&
    metrics.mcUsd >= f.minMcUsd &&
    metrics.holderCount >= f.minHolderCount &&
    metrics.rugcheckScore >= f.minRugcheckScore
  )
}
