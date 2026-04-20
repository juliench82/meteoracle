import type { Strategy } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'
import { scalpSpikeStrategy } from './scalp-spike'
import { stableFarmStrategy } from './stable-farm'
import { bluechipFarmStrategy } from './bluechip-farm'

/**
 * All registered strategies.
 */
export const STRATEGIES: Strategy[] = [
  evilPandaStrategy,
  scalpSpikeStrategy,
  stableFarmStrategy,
  bluechipFarmStrategy,
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
 * BLUECHIP       — large-cap, long-lived, broadly-held pairs
 *                  → Bluechip Farm
 *
 * STABLE         — known stablecoin mints or stable-stable pairs
 *                  → Stable Farm (tight bid-ask)
 *
 * UNKNOWN        — doesn't cleanly fit any class → no position opened
 */
export type TokenClass = 'MEME_SHITCOIN' | 'SCALP_SPIKE' | 'BLUECHIP' | 'STABLE' | 'UNKNOWN'

const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',
  'Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
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
  const { address, mcUsd, liquidityUsd, ageHours, topHolderPct, holderCount } = token

  if (STABLE_MINTS.has(address)) return 'STABLE'

  const vol1h    = token.volume1h ?? (token.volume24h / 24)
  const vol1hLiq = liquidityUsd > 0 ? vol1h / liquidityUsd : 0

  let memeCount = 0
  if (ageHours     <  48)        memeCount++
  if (mcUsd        <  3_000_000) memeCount++
  if (vol1hLiq     >  0.05)      memeCount++
  if (topHolderPct >  35)        memeCount++
  if (memeCount >= 2) {
    return 'MEME_SHITCOIN'
  }

  if (ageHours > 720 && mcUsd > 100_000_000 && topHolderPct < 25 && holderCount > 5_000) {
    return 'BLUECHIP'
  }

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
  BLUECHIP:      bluechipFarmStrategy,
  STABLE:        stableFarmStrategy,
}

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
