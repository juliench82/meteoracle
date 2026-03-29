import type { Strategy } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'
import { scalpSpikeStrategy } from './scalp-spike'
import { stableFarmStrategy } from './stable-farm'

/**
 * All registered strategies, evaluated in priority order.
 * Scalp Spike runs first (most selective / time-sensitive),
 * then Evil Panda (broad memecoin coverage),
 * then Stable Farm (catch-all for large established pairs).
 */
export const STRATEGIES: Strategy[] = [
  scalpSpikeStrategy,  // priority 1 — fast, tight, high-volume spikes
  evilPandaStrategy,   // priority 2 — wide-range memecoin fee farming
  stableFarmStrategy,  // priority 3 — low-risk established pair farming
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

/**
 * Returns all strategies that match a token (not just the first).
 * Useful for the dashboard to show all potential matches.
 */
export function getAllMatchingStrategies(token: {
  mcUsd: number
  volume24h: number
  liquidityUsd: number
  topHolderPct: number
  holderCount: number
  ageHours: number
  rugcheckScore: number
}): Strategy[] {
  return STRATEGIES.filter((s) => {
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
  })
}
