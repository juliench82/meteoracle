import type { Strategy } from '@/lib/types'
import { evilPandaStrategy } from './evil-panda'
import { scalpSpikeStrategy } from './scalp-spike'
import { stableFarmStrategy } from './stable-farm'
import { bluechipFarmStrategy } from './bluechip-farm'

export const STRATEGIES: Strategy[] = [
  evilPandaStrategy,
  scalpSpikeStrategy,
  stableFarmStrategy,
  bluechipFarmStrategy,
]

/**
 * Token class classification.
 *
 * MEME_SHITCOIN  — default for all SOL-paired tokens that don't qualify for
 *                  SCALP_SPIKE or BLUECHIP. MC is irrelevant — a $100M utility
 *                  token on SOL is still treated as a shitcoin for LP purposes.
 *                  → Evil Panda (wide range, short duration)
 *
 * SCALP_SPIKE    — any token (meme or utility) age>=48h + MC>=500K experiencing
 *                  a real volume surge (vol1h >= SCALP_SPIKE_VOL_RATIO × 24h avg).
 *                  → Scalp-Spike (tight range, hard exit)
 *
 * BLUECHIP       — large-cap, long-lived, broadly-held, USDC/USDT-quoted pool.
 *                  SOL-paired tokens never qualify regardless of MC.
 *                  → Bluechip Farm (moderate range, medium duration)
 *
 * STABLE         — known stablecoin mints or stable-stable pairs.
 *                  → Stable Farm (tight bid-ask)
 *
 * UNKNOWN        — passes no class → no position opened
 */
export type TokenClass = 'MEME_SHITCOIN' | 'SCALP_SPIKE' | 'BLUECHIP' | 'STABLE' | 'UNKNOWN'

const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',
  'Ea5SjE2Y6yvCeW5dYTn7PYMuW5ikXkvbGdcmSnXeaLjS',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',
])

const BLUECHIP_QUOTE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // USDC.e (Wormhole)
])

// Tunable via env — default 3.0× the 24h hourly average
const SCALP_SPIKE_VOL_RATIO = parseFloat(process.env.SCALP_SPIKE_VOL_RATIO ?? '3.0')

export function classifyToken(token: {
  address:        string
  mcUsd:          number
  volume24h:      number
  volume1h?:      number
  liquidityUsd:   number
  ageHours:       number
  topHolderPct:   number
  holderCount:    number
  rugcheckScore:  number
  quoteTokenMint?: string
}): TokenClass {
  const { address, mcUsd, ageHours, topHolderPct, holderCount } = token

  if (STABLE_MINTS.has(address)) return 'STABLE'

  // BLUECHIP: large-cap, long-lived, stable-quoted only
  if (
    ageHours        >  720          &&
    mcUsd           >  100_000_000  &&
    topHolderPct    <  25           &&
    holderCount     >  5_000        &&
    token.quoteTokenMint !== undefined &&
    BLUECHIP_QUOTE_MINTS.has(token.quoteTokenMint)
  ) {
    return 'BLUECHIP'
  }

  // SCALP_SPIKE: any token age>=48h + MC>=500K with a real volume surge
  const vol1h    = token.volume1h ?? (token.volume24h / 24)
  const avgVol1h = token.volume24h / 24
  const volRatio = avgVol1h > 0 ? vol1h / avgVol1h : 0

  if (
    ageHours >= 48          &&
    mcUsd    >= 500_000     &&
    volRatio >= SCALP_SPIKE_VOL_RATIO
  ) {
    return 'SCALP_SPIKE'
  }

  // MEME_SHITCOIN: default fallback — SOL-paired, didn't qualify above
  // MC ceiling deliberately removed: a $100M utility token is still a shitcoin for LP
  return 'MEME_SHITCOIN'
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

function passesBinStepFilter(strategy: Strategy, binStep?: number): boolean {
  const min = strategy.filters.minBinStep
  if (min === undefined) return true
  if (binStep === undefined) return true  // unknown bin step — allow through
  return binStep >= min
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
  binStep?:       number
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
    passesQuoteMintFilter(strategy, token.quoteTokenMint) &&
    passesBinStepFilter(strategy, token.binStep)

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
  binStep?:       number
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
      passesQuoteMintFilter(s, token.quoteTokenMint) &&
      passesBinStepFilter(s, token.binStep)
    )
  })
}

export function explainNoStrategy(t: {
  mcUsd: number; volume24h: number; liquidityUsd: number
  topHolderPct: number; holderCount: number; ageHours: number
  rugcheckScore: number; feeTvl24hPct: number; quoteTokenMint?: string
  binStep?: number
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
    if (f.minBinStep !== undefined && t.binStep !== undefined && t.binStep < f.minBinStep) {
      fails.push(`binStep=${t.binStep}<${f.minBinStep}`)
    }
    if (f.requiredQuoteMints && f.requiredQuoteMints.length > 0) {
      if (!t.quoteTokenMint || !f.requiredQuoteMints.includes(t.quoteTokenMint)) {
        fails.push(`quote=${t.quoteTokenMint ?? 'unknown'} not in [USDC/USDT]`)
      }
    }
    return fails.length === 0 ? null : `[${s.id}: ${fails.join(', ')}]`
  }).filter(Boolean)
  return perStrat.join(' | ') || 'all strategies disabled'
}
