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
 * BLUECHIP       — large-cap, long-lived, broadly-held pairs quoted in USDC/USDT
 *                  → Bluechip Farm
 *                  NOTE: SOL-paired tokens can never be BLUECHIP regardless of MC.
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

// Bluechip pools MUST be quoted in one of these stables — never SOL.
const BLUECHIP_QUOTE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // USDC.e (Wormhole)
])

export function classifyToken(token: {
  address:       string
  mcUsd:         number
  volume24h:     number
  volume1h?:     number
  liquidityUsd:  number
  ageHours:      number
  topHolderPct:  number
  holderCount:   number
  rugcheckScore: number
  /** Quote token mint of the selected pool. Required for BLUECHIP classification. */
  quoteTokenMint?: string
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

  // BLUECHIP: large-cap, long-lived, broad ownership AND stable-quoted pool.
  // A SOL-paired token with $100M MC is still a shitcoin — not a bluechip.
  if (
    ageHours > 720 &&
    mcUsd > 100_000_000 &&
    topHolderPct < 25 &&
    holderCount > 5_000 &&
    token.quoteTokenMint !== undefined &&
    BLUECHIP_QUOTE_MINTS.has(token.quoteTokenMint)
  ) {
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

function passesQuoteMintFilter(strategy: Strategy, quoteTokenMint?: string): boolean {
  const required = strategy.filters.requiredQuoteMints
  if (!required || required.length === 0) return true
  if (!quoteTokenMint) return false
  return required.includes(quoteTokenMint)
}

export function getStrategyForToken(token: {
  address?:       string
  mcUsd:          number
  volume24h:      number
  volume1h?:      number
  liquidityUsd:   number
  topHolderPct:   number
  holderCount:    number
  ageHours:       number
  rugcheckScore:  number
  quoteTokenMint?: string
}): Strategy | null {
  const tokenClass = classifyToken({ address: token.address ?? '', ...token })
  if (tokenClass === 'UNKNOWN') return null

  const strategy = CLASS_STRATEGY[tokenClass]
  if (!strategy.enabled) return null

  const f = strategy.filters
  const passes =
    token.mcUsd         >= f.minMcUsd        &&
    token.mcUsd         <= f.maxMcUsd        &&
    token.volume24h     >= f.minVolume24h     &&
    token.liquidityUsd  >= f.minLiquidityUsd  &&
    token.topHolderPct  <= f.maxTopHolderPct  &&
    token.holderCount   >= f.minHolderCount   &&
    token.ageHours      <= f.maxAgeHours      &&
    token.rugcheckScore >= f.minRugcheckScore  &&
    passesQuoteMintFilter(strategy, token.quoteTokenMint)

  return passes ? strategy : null
}

export function getAllMatchingStrategies(token: {
  address?:       string
  mcUsd:          number
  volume24h:      number
  volume1h?:      number
  liquidityUsd:   number
  topHolderPct:   number
  holderCount:    number
  ageHours:       number
  rugcheckScore:  number
  quoteTokenMint?: string
}): Strategy[] {
  return STRATEGIES.filter((s) => {
    if (!s.enabled) return false
    const f = s.filters
    return (
      token.mcUsd         >= f.minMcUsd        &&
      token.mcUsd         <= f.maxMcUsd        &&
      token.volume24h     >= f.minVolume24h     &&
      token.liquidityUsd  >= f.minLiquidityUsd  &&
      token.topHolderPct  <= f.maxTopHolderPct  &&
      token.holderCount   >= f.minHolderCount   &&
      token.ageHours      <= f.maxAgeHours      &&
      token.rugcheckScore >= f.minRugcheckScore  &&
      passesQuoteMintFilter(s, token.quoteTokenMint)
    )
  })
}

/** For scanner debug logging — explains why each strategy rejected a token. */
export function explainNoStrategy(t: {
  mcUsd: number; volume24h: number; liquidityUsd: number
  topHolderPct: number; holderCount: number; ageHours: number
  rugcheckScore: number; feeTvl24hPct: number; quoteTokenMint?: string
}): string {
  const perStrat = STRATEGIES.filter(s => s.enabled).map(s => {
    const f = s.filters
    const fails: string[] = []
    if (t.mcUsd          < f.minMcUsd)        fails.push(`mc=$${t.mcUsd.toFixed(0)}<$${f.minMcUsd}`)
    if (t.mcUsd          > f.maxMcUsd)        fails.push(`mc too high`)
    if (t.volume24h      < f.minVolume24h)    fails.push(`vol=$${t.volume24h.toFixed(0)}<$${f.minVolume24h}`)
    if (t.liquidityUsd   < f.minLiquidityUsd) fails.push(`liq=$${t.liquidityUsd.toFixed(0)}<$${f.minLiquidityUsd}`)
    if (t.topHolderPct   > f.maxTopHolderPct) fails.push(`topHolder=${t.topHolderPct.toFixed(1)}%>${f.maxTopHolderPct}%`)
    if (t.holderCount    < f.minHolderCount)  fails.push(`holders=${t.holderCount}<${f.minHolderCount}`)
    if (t.ageHours       > f.maxAgeHours)     fails.push(`age=${t.ageHours.toFixed(1)}h>${f.maxAgeHours}h`)
    if (t.rugcheckScore  < f.minRugcheckScore) fails.push(`rug=${t.rugcheckScore}<${f.minRugcheckScore}`)
    if (t.feeTvl24hPct   < f.minFeeTvl24hPct) fails.push(`feeTvl=${t.feeTvl24hPct.toFixed(2)}%<${f.minFeeTvl24hPct}%`)
    if (f.requiredQuoteMints && f.requiredQuoteMints.length > 0) {
      if (!t.quoteTokenMint || !f.requiredQuoteMints.includes(t.quoteTokenMint)) {
        fails.push(`quote=${t.quoteTokenMint ?? 'unknown'} not in [${f.requiredQuoteMints.join(',')}]`)
      }
    }
    return fails.length === 0 ? null : `[${s.id}: ${fails.join(', ')}]`
  }).filter(Boolean)
  return perStrat.join(' | ') || 'all strategies disabled'
}
