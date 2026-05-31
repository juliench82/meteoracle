import type { Strategy, TokenMetrics } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'
import { moonboyStrategy } from './moonboy'
import { scalpSpikeStrategy } from './scalp-spike' // stubbed for restored code during transition

/**
 * Minimal strategy registry for the current architecture.
 *
 * Only two things exist:
 * - evil-panda: LP on very fresh shitcoins
 * - moonboy: companion spot buy (max 3 concurrent, exit at 2x)
 */

export const STRATEGIES: Strategy[] = [
  evilPandaStrategy,
  moonboyStrategy,
]

export type StrategyId = Strategy['id']

export function getStrategyById(id: StrategyId): Strategy | null {
  return STRATEGIES.find((s) => s.id === id) ?? null
}

/**
 * Returns evil-panda only if the token is fresh enough and passes basic safety.
 */
export function classifyToken() {
  return { type: 'unknown' };
}

export function getStrategyForToken(token: TokenMetrics, forcedStrategyId?: StrategyId): Strategy | null {
  if (forcedStrategyId) {
    const forced = getStrategyById(forcedStrategyId)
    return forced?.enabled ? forced : null
  }

  const s = evilPandaStrategy
  if (!s.enabled) return null

  const f = s.filters

  if (
    token.ageHours <= 1.5 &&
    token.liquidityUsd >= f.minLiquidityUsd &&
    token.rugcheckScore >= f.minRugcheckScore &&
    token.topHolderPct <= f.maxTopHolderPct &&
    token.holderCount >= f.minHolderCount
  ) {
    return s
  }

  return null
}

/**
 * Simple rejection reason for logging.
 */
export function explainNoStrategy(t: TokenMetrics): string {
  const s = evilPandaStrategy
  const f = s.filters
  const reasons: string[] = []

  if (t.ageHours > 1.5) reasons.push(`age=${t.ageHours.toFixed(1)}h > 1.5h`)
  if (t.liquidityUsd < f.minLiquidityUsd) reasons.push('liquidity too low')
  if (t.rugcheckScore < f.minRugcheckScore) reasons.push('rugcheck too low')
  if (t.topHolderPct > f.maxTopHolderPct) reasons.push('top holder too high')
  if (t.holderCount < f.minHolderCount) reasons.push('not enough holders')

  return reasons.length ? reasons.join(', ') : 'did not pass evil-panda filters'
}
