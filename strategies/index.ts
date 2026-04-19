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
 * Token class classification.
 *
 * MEME_SHITCOIN  — fresh low-cap memecoins, pump risk, wide-range fee farm
 *                  → Evil Panda
 *
 * SCALP_SPIKE    — established memecoins, sustained vol, predictable ranges
 *                  → Scalp-Spike
 *
 * BLUECHIP       — deep liquidity, high MC, long-lived pairs
 *                  → Stable Farm
 *
 * STABLE         — known stablecoin mints or stable-stable pairs
 *                  → Stable Farm (tight bid-ask)
 *
 * UNKNOWN        — doesn't cleanly fit any class → no position opened
 *
 * Criteria:
 *   MEME_SHITCOIN : ANY TWO of: pool_age < 48h, mcap < $3M, vol1h/liq > 5%, top10holders > 35%
 *   SCALP_SPIKE   : 48h < age < 30d  AND  $3M < mc < $20M  AND  vol1h/liq <= 5%
 *   BLUECHIP      : age > 30d  AND  mc > $20M  AND  top10holders < 25%
 *   STABLE        : mint is USDC/USDT  OR  both tokens in pair are stables
 */
export type TokenClass = 'MEME_SHITCOIN' | 'SCALP_SPIKE' | 'BLUECHIP' | 'STABLE' | 'UNKNOWN'

// Known stablecoin mints
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',  // USDH
  'Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS', // PAI
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL (treated as quasi-stable for range purposes)
])

export function classifyToken(token: {
  address:      string
  mcUsd:        number
  volume24h:    number
  volume1h?:    number
  liquidityUsd: number
  ageHours:     number
  topHolderPct: number
  holderCount:  number
  rugcheckScore: number
}): TokenClass {
  const { address, mcUsd, liquidityUsd, ageHours, topHolderPct } = token

  // STABLE: known mint
  if (STABLE_MINTS.has(address)) return 'STABLE'

  // vol1h/liq ratio — proxy for 5min spike risk
  // Uses volume['1h'] from Meteora. If unavailable falls back to vol24h/24.
  const vol1h    = token.volume1h ?? (token.volume24h / 24)
  const vol1hLiq = liquidityUsd > 0 ? vol1h / liquidityUsd : 0

  // MEME_SHITCOIN: require ANY TWO conditions
  // age < 48h extended from 24h to close the 24-48h UNKNOWN gap
  let memeCount = 0
  if (ageHours     <  48)        memeCount++ // extended from 24h — was dropping 24-48h tokens into UNKNOWN
  if (mcUsd        <  3_000_000) memeCount++
  if (vol1hLiq     >  0.05)      memeCount++
  if (topHolderPct >  35)        memeCount++
  if (memeCount >= 2) {
    return 'MEME_SHITCOIN'
  }

  // BLUECHIP: check before SCALP_SPIKE so large-caps don't fall into spike bucket
  if (ageHours > 720 && mcUsd > 20_000_000 && topHolderPct < 25) {
    return 'BLUECHIP'
  }

  // SCALP_SPIKE
  if (
    ageHours >= 48 && ageHours <= 720 &&
    mcUsd    >  3_000_000 && mcUsd <= 20_000_000 &&
    vol1hLiq <= 0.05
  ) {
    return 'SCALP_SPIKE'
  }

  return 'UNKNOWN'
}

const CLASS_STRATEGY: Record<Exclude<TokenClass, 'UNKNOWN'>, Strategy> = {
  MEME_SHITCOIN: evilPandaStrategy,
  SCALP_SPIKE:   scalpSpikeStrategy,
  BLUECHIP:      stableFarmStrategy,
  STABLE:        stableFarmStrategy,
}

/**
 * Returns the correct strategy for a token based on its class.
 * Applies the strategy's own filters as a second-pass safety check.
 * Returns null if class is UNKNOWN, strategy is disabled, or filters fail.
 */
export function getStrategyForToken(token: {
  address?:     string
  mcUsd:        number
  volume24h:    number
  volume1h?:    number
  liquidityUsd: number
  topHolderPct: number
  holderCount:  number
  ageHours:     number
  rugcheckScore: number
}): Strategy | null {
  const tokenClass = classifyToken({ address: token.address ?? '', ...token })
  if (tokenClass === 'UNKNOWN') return null

  const strategy = CLASS_STRATEGY[tokenClass]
  if (!strategy.enabled) return null

  const f = strategy.filters
  const passes =
    token.mcUsd        >= f.minMcUsd          &&
    token.mcUsd        <= f.maxMcUsd          &&
    token.volume24h    >= f.minVolume24h       &&
    token.liquidityUsd >= f.minLiquidityUsd   &&
    token.topHolderPct <= f.maxTopHolderPct   &&
    token.holderCount  >= f.minHolderCount    &&
    token.ageHours     <= f.maxAgeHours       &&
    token.rugcheckScore >= f.minRugcheckScore

  return passes ? strategy : null
}

/**
 * Returns all strategies that would match a token across all classes.
 * Used by the dashboard to show potential matches.
 */
export function getAllMatchingStrategies(token: {
  address?:     string
  mcUsd:        number
  volume24h:    number
  volume1h?:    number
  liquidityUsd: number
  topHolderPct: number
  holderCount:  number
  ageHours:     number
  rugcheckScore: number
}): Strategy[] {
  return STRATEGIES.filter((s) => {
    if (!s.enabled) return false
    const f = s.filters
    return (
      token.mcUsd        >= f.minMcUsd          &&
      token.mcUsd        <= f.maxMcUsd          &&
      token.volume24h    >= f.minVolume24h       &&
      token.liquidityUsd >= f.minLiquidityUsd   &&
      token.topHolderPct <= f.maxTopHolderPct   &&
      token.holderCount  >= f.minHolderCount    &&
      token.ageHours     <= f.maxAgeHours       &&
      token.rugcheckScore >= f.minRugcheckScore
    )
  })
}
