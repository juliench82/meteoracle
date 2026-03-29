import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { DexScreenerPair, TokenMetrics } from '@/lib/types'

/**
 * Pre-filter thresholds — applied to raw DexScreener data BEFORE
 * any Helius calls. Keeps credit usage well within free tier.
 *
 * Conservative estimate:
 *   DexScreener returns ~500 new Solana pairs/hour
 *   Pre-filter keeps ~5% = ~25 tokens/hour passing to Helius
 *   25 * 3 credits * 24h = 1,800 credits/day (well under 100k limit)
 */
const PRE_FILTER = {
  minVolume24hUsd: 50_000,    // must have real trading activity
  minLiquidityUsd: 20_000,    // enough liquidity to enter without slippage
  maxMcUsd: 100_000_000,      // ignore mega-caps (not our target)
  minMcUsd: 10_000,           // ignore dust/dead tokens
  maxAgeHours: 72,            // ignore old tokens (strategies cap at 72h max)
}

/**
 * Main scanner — fetches new Solana pairs from DexScreener,
 * applies pre-filter, enriches survivors with Helius + Rugcheck,
 * matches to a strategy, and persists candidates to Supabase.
 */
export async function runScanner(): Promise<{ scanned: number; candidates: number }> {
  console.log('[scanner] tick started')

  // 1. Fetch new/trending Solana pairs from DexScreener
  const pairs = await fetchDexScreenerPairs()
  console.log(`[scanner] fetched ${pairs.length} pairs from DexScreener`)

  // 2. Pre-filter using DexScreener data only (no API credits spent)
  const preFiltered = pairs.filter(applyPreFilter)
  console.log(`[scanner] ${preFiltered.length} passed pre-filter`)

  let candidateCount = 0
  const supabase = createServerClient()

  for (const pair of preFiltered) {
    try {
      // 3. Skip if we've already scanned this token recently (within 1h)
      const tokenAddress = pair.baseToken.address
      const { data: existing } = await supabase
        .from('candidates')
        .select('id')
        .eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(1)

      if (existing && existing.length > 0) continue

      // 4. Helius: fetch holder data (credits spent here)
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      // 5. Rugcheck score (free, no rate limit concerns)
      const rugScore = await checkRugscore(tokenAddress)

      // 6. Build full token metrics
      const metrics: TokenMetrics = {
        address: tokenAddress,
        symbol: pair.baseToken.symbol,
        mcUsd: pair.marketCap ?? 0,
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

      // 7. Match to a strategy
      const strategy = getStrategyForToken(metrics)
      if (!strategy) continue

      // 8. Score the candidate
      const score = scoreCandidate(metrics)

      // 9. Persist to Supabase candidates table
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
    } catch (err) {
      console.error(`[scanner] error processing ${pair.baseToken.symbol}:`, err)
    }
  }

  console.log(`[scanner] done. ${candidateCount} new candidates from ${preFiltered.length} pre-filtered`)
  return { scanned: preFiltered.length, candidates: candidateCount }
}

// ---------------------------------------------------------------------------
// DexScreener fetcher
// ---------------------------------------------------------------------------

async function fetchDexScreenerPairs(): Promise<DexScreenerPair[]> {
  try {
    // Primary: latest Solana pairs sorted by creation time
    const [newPairsRes, trendingRes] = await Promise.allSettled([
      axios.get<{ pairs: DexScreenerPair[] }>(
        'https://api.dexscreener.com/token-profiles/latest/v1',
        { timeout: 10_000 }
      ),
      axios.get<{ pairs: DexScreenerPair[] }>(
        'https://api.dexscreener.com/latest/dex/search?q=SOL&chainId=solana',
        { timeout: 10_000 }
      ),
    ])

    const pairs: DexScreenerPair[] = []

    if (newPairsRes.status === 'fulfilled' && newPairsRes.value.data?.pairs) {
      const solanaPairs = newPairsRes.value.data.pairs.filter(
        (p) => p.chainId === 'solana'
      )
      pairs.push(...solanaPairs)
    }

    if (trendingRes.status === 'fulfilled' && trendingRes.value.data?.pairs) {
      pairs.push(...trendingRes.value.data.pairs)
    }

    // Deduplicate by pairAddress
    const seen = new Set<string>()
    return pairs.filter((p) => {
      if (seen.has(p.pairAddress)) return false
      seen.add(p.pairAddress)
      return true
    })
  } catch (err) {
    console.error('[scanner] DexScreener fetch failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// Pre-filter (DexScreener data only, zero API credits)
// ---------------------------------------------------------------------------

function applyPreFilter(pair: DexScreenerPair): boolean {
  const vol24h = pair.volume?.h24 ?? 0
  const liquidity = pair.liquidity?.usd ?? 0
  const mc = pair.marketCap ?? 0
  const ageHours = getAgeHours(pair.pairCreatedAt)

  return (
    vol24h >= PRE_FILTER.minVolume24hUsd &&
    liquidity >= PRE_FILTER.minLiquidityUsd &&
    mc >= PRE_FILTER.minMcUsd &&
    mc <= PRE_FILTER.maxMcUsd &&
    ageHours <= PRE_FILTER.maxAgeHours &&
    // Must be a real token pair (not a honeypot flag from DexScreener)
    !pair.labels?.includes('honeypot')
  )
}

function getAgeHours(pairCreatedAt?: number): number {
  if (!pairCreatedAt) return 999
  return (Date.now() - pairCreatedAt) / (1000 * 60 * 60)
}
