import type { Strategy } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'

// All registered strategies
export const STRATEGIES: Strategy[] = [
  evilPandaStrategy,
  // future: scalpSpikeStrategy, stableFarmStrategy, etc.
]

/**
 * Returns the first matching strategy for a given token's metrics.
 * Strategies are evaluated in order — first match wins.
 */
export function getStrategyForToken(token: {
  mcUsd: number
  volume24h: number
  liquidityUsd: number
  topHolderPct: number
  holderCount: number
  ageHours: number
  rugcheckScore: number
}): Strategy | null {
  return (
    STRATEGIES.find((s) => {
      if (!s.enabled) return false
      const f = s.filters
      return (
        token.mcUsd >= f.minMcUsd &&
        token.mcUsd <= f.maxMcUsd &&
        token.volume24h >= f.minVolume24h &&
        token.liquidityUsd >= f.minLiquidityUsd &&
        token.topHolderPct <= f.maxTopHolderPct &&
        token.holderCount >= f.minHolderCount &&
        token.ageHours <= f.maxAgeHours &&
        token.rugcheckScore >= f.minRugcheckScore
      )
    }) ?? null
  )
}
