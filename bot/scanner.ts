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
 *
 * Conservative estimate:
 *   DexScreener returns ~500 new Solana pairs/hour
 *   Pre-filter keeps ~5% = ~25 tokens/hour passing to Helius
 *   25 * 3 credits * 24h = 1,800 credits/day (well under 100k limit)
 */
const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxMcUsd: 100_000_000,
  minMcUsd: 10_000,
  maxAgeHours: 72,
}

/** Minimum score a candidate must reach before opening a position */
const MIN_SCORE_TO_OPEN = parseInt(process.env.MIN_SCORE_TO_OPEN ?? '65')

/** Maximum concurrent open positions across all strategies */
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

/**
 * Main scanner — fetches new Solana pairs from DexScreener,
 * applies pre-filter, enriches survivors with Helius + Rugcheck,
 * matches to a strategy, scores, persists candidates,
 * and opens a position if score threshold is met.
 */
export async function runScanner(): Promise<{ scanned: number; candidates: number; opened: number }> {
  console.log('[scanner] tick started')

  const supabase = createServerClient()

  // Guard: check current open position count before doing any work
  const { count: openCount } = await supabase
    .from('positions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['active', 'out_of_range'])

  if ((openCount ?? 0) >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[scanner] max concurrent positions reached (${openCount}/${MAX_CONCURRENT_POSITIONS}) — skipping scan`)
    return { scanned: 0, candidates: 0, opened: 0 }
  }

  // 1. Fetch new/trending Solana pairs from DexScreener
  const pairs = await fetchDexScreenerPairs()
  console.log(`[scanner] fetched ${pairs.length} pairs from DexScreener`)

  // 2. Pre-filter using DexScreener data only (no API credits spent)
  const preFiltered = pairs.filter(applyPreFilter)
  console.log(`[scanner] ${preFiltered.length} passed pre-filter`)

  let candidateCount = 0
  let openedCount = 0

  for (const pair of preFiltered) {
    // Stop opening more if we hit the cap mid-loop
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    try {
      const tokenAddress = pair.baseToken.address

      // 3. Skip if already scanned recently (within 1h)
      const { data: existing } = await supabase
        .from('candidates')
        .select('id')
        .eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(1)

      if (existing && existing.length > 0) continue

      // 4. Skip if we already have an open position for this token
      const { data: existingPosition } = await supabase
        .from('positions')
        .select('id')
        .eq('token_address', tokenAddress)
        .in('status', ['active', 'out_of_range'])
        .limit(1)

      if (existingPosition && existingPosition.length > 0) continue

      // 5. Helius: fetch holder data (credits spent here)
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      // 6. Rugcheck score (free)
      const rugScore = await checkRugscore(tokenAddress)

      // 7. Build full token metrics
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

      // 8. Match to a strategy
      const strategy = getStrategyForToken(metrics)
      if (!strategy) continue

      // 9. Score the candidate
      const score = scoreCandidate(metrics)

      // 10. Persist candidate regardless of score
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

      // 11. Alert on new candidate
      await sendAlert({
        type: 'candidate_found',
        symbol: metrics.symbol,
        strategy: strategy.id,
        score,
        mcUsd: metrics.mcUsd,
        volume24h: metrics.volume24h,
      })

      // 12. Open position if score is high enough
      if (score >= MIN_SCORE_TO_OPEN) {
        console.log(`[scanner] score ${score} >= ${MIN_SCORE_TO_OPEN} — opening position for ${metrics.symbol}`)
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
      console.error(`[scanner] error processing ${pair.baseToken.symbol}:`, err)
    }
  }

  console.log(`[scanner] done. candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: preFiltered.length, candidates: candidateCount, opened: openedCount }
}

// ---------------------------------------------------------------------------
// DexScreener fetcher
// ---------------------------------------------------------------------------

async function fetchDexScreenerPairs(): Promise<DexScreenerPair[]> {
  try {
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
      pairs.push(...newPairsRes.value.data.pairs.filter((p) => p.chainId === 'solana'))
    }
    if (trendingRes.status === 'fulfilled' && trendingRes.value.data?.pairs) {
      pairs.push(...trendingRes.value.data.pairs)
    }

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
// Pre-filter
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
    !pair.labels?.includes('honeypot')
  )
}

function getAgeHours(pairCreatedAt?: number): number {
  if (!pairCreatedAt) return 999
  return (Date.now() - pairCreatedAt) / (1000 * 60 * 60)
}
