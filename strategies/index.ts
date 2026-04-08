import type { Strategy } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'
import { scalpSpikeStrategy } from './scalp-spike'
import { stableFarmStrategy } from './stable-farm'

/**
 * All registered strategies.
 */
export const STRATEGIES: Strategy[] = [
  evilPandaStrategy,
  scalpSpikeStrategy,
  stableFarmStrategy,
]

/**
 * Token tier classification.
 *
 * SHITCOIN   — fresh low-cap memecoins, expect dump, farm fees through it
 *              → Evil Panda (wide range, single-sided, high dump tolerance)
 *
 * MEMECOIN   — established memecoins with sustained volume and proven age
 *              → Scalp Spike (tight range, fast exit, spike capture)
 *
 * LARGE_CAP  — deep liquidity, high MC, long-lived pairs
 *              → Stable Farm (curve distribution, long duration)
 *
 * UNKNOWN    — doesn't cleanly fit any tier → no position opened
 */
type TokenTier = 'SHITCOIN' | 'MEMECOIN' | 'LARGE_CAP' | 'UNKNOWN'

function classifyToken(token: {
  mcUsd: number
  volume24h: number
  liquidityUsd: number
  ageHours: number
  holderCount: number
  rugcheckScore: number
}): TokenTier {
  const { mcUsd, liquidityUsd, ageHours, holderCount } = token

  // LARGE_CAP: deep liquidity + high MC — must check first to avoid misclassifying
  if (mcUsd >= 10_000_000 && liquidityUsd >= 500_000 && holderCount >= 1_000) {
    return 'LARGE_CAP'
  }

  // MEMECOIN: established — not a fresh launch, meaningful MC, enough holders
  // Minimum 72h old to rule out pump-and-dump launches
  if (mcUsd >= 5_000_000 && mcUsd < 50_000_000 && ageHours >= 72 && holderCount >= 500) {
    return 'MEMECOIN'
  }

  // SHITCOIN: small MC fresh token — the classic memecoin dump profile
  if (mcUsd < 5_000_000 && ageHours < 120) {
    return 'SHITCOIN'
  }

  return 'UNKNOWN'
}

const TIER_STRATEGY: Record<Exclude<TokenTier, 'UNKNOWN'>, Strategy> = {
  SHITCOIN:  evilPandaStrategy,
  MEMECOIN:  scalpSpikeStrategy,
  LARGE_CAP: stableFarmStrategy,
}

/**
 * Returns the correct strategy for a token based on its tier.
 * Applies the strategy's own filters as a second-pass safety check.
 * Returns null if tier is UNKNOWN, strategy is disabled, or filters fail.
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
  const tier = classifyToken(token)
  if (tier === 'UNKNOWN') return null

  const strategy = TIER_STRATEGY[tier]
  if (!strategy.enabled) return null

  // Second-pass: strategy's own filters still apply (vol, rugcheck, holder %, etc.)
  const f = strategy.filters
  const passes =
    token.mcUsd >= f.minMcUsd &&
    token.mcUsd <= f.maxMcUsd &&
    token.volume24h >= f.minVolume24h &&
    token.liquidityUsd >= f.minLiquidityUsd &&
    token.topHolderPct <= f.maxTopHolderPct &&
    token.holderCount >= f.minHolderCount &&
    token.ageHours <= f.maxAgeHours &&
    token.rugcheckScore >= f.minRugcheckScore

  return passes ? strategy : null
}

/**
 * Returns all strategies that would match a token across all tiers.
 * Used by the dashboard to show potential matches.
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
