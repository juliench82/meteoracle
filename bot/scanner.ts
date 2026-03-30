import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { DexScreenerPair, TokenMetrics } from '@/lib/types'

/**
 * Pre-filter thresholds — applied to raw DexScreener data BEFORE
 * any Helius calls. Keeps credit usage well within free tier.
 */
const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxMcUsd: 100_000_000,
  minMcUsd: 10_000,
  maxAgeHours: 72,
}

const MIN_SCORE_TO_OPEN = parseInt(process.env.MIN_SCORE_TO_OPEN ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

export async function runScanner(): Promise<{ scanned: number; candidates: number; opened: number }> {
  console.log('[scanner] tick started')

  const supabase = createServerClient()

  const { count: openCount } = await supabase
    .from('positions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['active', 'out_of_range'])

  if ((openCount ?? 0) >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[scanner] max positions reached (${openCount}/${MAX_CONCURRENT_POSITIONS})`)
    return { scanned: 0, candidates: 0, opened: 0 }
  }

  const pairs = await fetchDexScreenerPairs()
  console.log(`[scanner] fetched ${pairs.length} pairs from DexScreener`)

  const preFiltered = pairs.filter(applyPreFilter)
  console.log(`[scanner] ${preFiltered.length} passed pre-filter`)

  let candidateCount = 0
  let openedCount = 0

  for (const pair of preFiltered) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    try {
      const tokenAddress = pair.baseToken.address

      const { data: existing } = await supabase
        .from('candidates')
        .select('id')
        .eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(1)
      if (existing && existing.length > 0) continue

      const { data: existingPosition } = await supabase
        .from('positions')
        .select('id')
        .eq('token_address', tokenAddress)
        .in('status', ['active', 'out_of_range'])
        .limit(1)
      if (existingPosition && existingPosition.length > 0) continue

      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      const rugScore = await checkRugscore(tokenAddress)

      const metrics: TokenMetrics = {
        address: tokenAddress,
        symbol: pair.baseToken.symbol,
        mcUsd: pair.marketCap ?? pair.fdv ?? 0,
        volume24h: pair.volume?.h24 ?? 0,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        topHolderPct: holderData.topHolderPct,
        holderCount: holderData.holderCount,
        ageHours: getAgeHours(pair.pairCreatedAt),
        rugcheckScore: rugScore,
        priceUsd: parseFloat(pair.priceUsd ?? '0'),
        poolAddress: pair.pairAddress,
        dexId: pair.dexId,
      }

      const strategy = getStrategyForToken(metrics)
      if (!strategy) continue

      const score = scoreCandidate(metrics)

      await supabase.from('candidates').insert({
        token_address: metrics.address,
        symbol: metrics.symbol,
        score,
        strategy_matched: strategy.id,
        mc_at_scan: metrics.mcUsd,
        volume_24h: metrics.volume24h,
        holder_count: metrics.holderCount,
        rugcheck_score: metrics.rugcheckScore,
        top_holder_pct: metrics.topHolderPct,
        scanned_at: new Date().toISOString(),
      })

      candidateCount++
      console.log(`[scanner] candidate: ${metrics.symbol} → ${strategy.id} (score: ${score})`)

      await sendAlert({
        type: 'candidate_found',
        symbol: metrics.symbol,
        strategy: strategy.id,
        score,
        mcUsd: metrics.mcUsd,
        volume24h: metrics.volume24h,
      })

      if (score >= MIN_SCORE_TO_OPEN) {
        const positionId = await openPosition(metrics, strategy)
        if (positionId) {
          openedCount++
          await sendAlert({
            type: 'position_opened',
            symbol: metrics.symbol,
            strategy: strategy.id,
            solDeposited: strategy.position.maxSolPerPosition,
            entryPrice: metrics.priceUsd,
          })
        }
      }
    } catch (err) {
      console.error(`[scanner] error processing ${pair.baseToken?.symbol}:`, err)
    }
  }

  console.log(`[scanner] done. candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: preFiltered.length, candidates: candidateCount, opened: openedCount }
}

// ---------------------------------------------------------------------------
// DexScreener fetcher
// Step 1: get new/boosted Solana token addresses from token-profiles endpoint
// Step 2: batch-fetch actual pair data for those tokens (has vol/liquidity/MC)
// ---------------------------------------------------------------------------

async function fetchDexScreenerPairs(): Promise<DexScreenerPair[]> {
  try {
    // Step 1: get latest new Solana token addresses (up to 30)
    const profilesRes = await axios.get<{ tokenAddress: string; chainId: string }[]>(
      'https://api.dexscreener.com/token-profiles/latest/v1',
      { timeout: 10_000 }
    )

    const solanaAddresses = (profilesRes.data ?? [])
      .filter((t) => t.chainId === 'solana')
      .map((t) => t.tokenAddress)
      .slice(0, 30)

    if (solanaAddresses.length === 0) return []

    // Step 2: batch fetch pair data in groups of 30 (API limit per call)
    // /tokens/{addresses} accepts comma-separated addresses
    const chunks: string[][] = []
    for (let i = 0; i < solanaAddresses.length; i += 30) {
      chunks.push(solanaAddresses.slice(i, i + 30))
    }

    const allPairs: DexScreenerPair[] = []

    await Promise.allSettled(
      chunks.map(async (chunk) => {
        const res = await axios.get<{ pairs: DexScreenerPair[] }>(
          `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`,
          { timeout: 10_000 }
        )
        const pairs = res.data?.pairs ?? []
        // Keep only Solana pairs, prefer Meteora DLMM pools
        allPairs.push(...pairs.filter((p) => p.chainId === 'solana'))
      })
    )

    // Deduplicate by pairAddress
    const seen = new Set<string>()
    return allPairs.filter((p) => {
      if (!p?.pairAddress || seen.has(p.pairAddress)) return false
      seen.add(p.pairAddress)
      return true
    })
  } catch (err) {
    console.error('[scanner] DexScreener fetch failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Pre-filter
// ---------------------------------------------------------------------------

function applyPreFilter(pair: DexScreenerPair): boolean {
  const vol24h = pair.volume?.h24 ?? 0
  const liquidity = pair.liquidity?.usd ?? 0
  const mc = pair.marketCap ?? pair.fdv ?? 0
  const ageHours = getAgeHours(pair.pairCreatedAt)

  return (
    vol24h >= PRE_FILTER.minVolume24hUsd &&
    liquidity >= PRE_FILTER.minLiquidityUsd &&
    mc >= PRE_FILTER.minMcUsd &&
    mc <= PRE_FILTER.maxMcUsd &&
    ageHours <= PRE_FILTER.maxAgeHours &&
    !pair.labels?.includes('honeypot')
  )
}

function getAgeHours(pairCreatedAt?: number): number {
  if (!pairCreatedAt) return 999
  return (Date.now() - pairCreatedAt) / (1000 * 60 * 60)
}
