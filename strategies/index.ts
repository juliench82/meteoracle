import type { Strategy, TokenMetrics } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'

/**
 * Minimal strategy registry for the current architecture.
 *
 * Only evil-panda: LP on pools using real documented /pools fields + derivations (per latest Claude recs). All previous fresh/15m/active_tvl logic removed.
 */

export const STRATEGIES: Strategy[] = [
  evilPandaStrategy,
]

export type StrategyId = Strategy['id']

export function getStrategyById(id: StrategyId): Strategy | null {
  return STRATEGIES.find((s) => s.id === id) ?? null
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
    token.ageHours <= f.maxAgeHours &&
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

  if (t.ageHours > f.maxAgeHours) reasons.push(`age=${t.ageHours.toFixed(1)}h > ${f.maxAgeHours}h`)
  if (t.liquidityUsd < f.minLiquidityUsd) reasons.push('liquidity too low')
  if (t.rugcheckScore < f.minRugcheckScore) reasons.push('rugcheck too low')
  if (t.topHolderPct > f.maxTopHolderPct) reasons.push('top holder too high')
  if (t.holderCount < f.minHolderCount) reasons.push('not enough holders')

  return reasons.length ? reasons.join(', ') : 'did not pass evil-panda filters'
}
