import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { TokenMetrics } from '@/lib/types'

const METEORA_API = 'https://dlmm-api.meteora.ag'

/**
 * Pre-filter applied to Meteora pairs before any Helius/DexScreener calls.
 * All values come directly from Meteora — no external credits spent here.
 */
const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 50_000_000, // skip mega pools — too much capital needed
  maxAgeHours: 72,             // pool created within last 3 days
}

const MIN_SCORE_TO_OPEN = parseInt(process.env.MIN_SCORE_TO_OPEN ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

// ---------------------------------------------------------------------------
// Meteora pair shape (subset of fields we use)
// ---------------------------------------------------------------------------
interface MeteoraPair {
  address: string
  name: string           // e.g. "BONK-SOL"
  mint_x: string         // base token mint
  mint_y: string         // quote token mint
  reserve_x_amount: number
  reserve_y_amount: number
  liquidity: number      // USD liquidity
  current_price: number
  apr: number
  apy: number
  base_fee_percentage: string
  max_fee_percentage: string
  trade_volume_24h: number
  fees_24h: number
  today_fees: number
  bin_step: number
  created_at?: string
}

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

  // 1. Fetch Meteora DLMM pairs
  const pairs = await fetchMeteoraPairs()
  console.log(`[scanner] fetched ${pairs.length} Meteora pairs`)

  // 2. Pre-filter using Meteora data only
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
      const tokenAddress = pair.mint_x
      const symbol = pair.name.split('-')[0] ?? pair.name

      // Skip if scanned recently
      const { data: existing } = await supabase
        .from('candidates')
        .select('id')
        .eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
        .limit(1)
      if (existing && existing.length > 0) continue

      // Skip if already have open position
      const { data: existingPosition } = await supabase
        .from('positions')
        .select('id')
        .eq('token_address', tokenAddress)
        .in('status', ['active', 'out_of_range'])
        .limit(1)
      if (existingPosition && existingPosition.length > 0) continue

      // 3. Enrich: get MC + age from DexScreener
      const dexData = await fetchDexScreenerEnrichment(tokenAddress)

      // 4. Helius: holder data
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      // 5. Rugcheck
      const rugScore = await checkRugscore(tokenAddress)

      const ageHours = pair.created_at
        ? (Date.now() - new Date(pair.created_at).getTime()) / (1000 * 60 * 60)
        : (dexData?.ageHours ?? 999)

      const metrics: TokenMetrics = {
        address: tokenAddress,
        symbol,
        mcUsd: dexData?.mcUsd ?? 0,
        volume24h: pair.trade_volume_24h,
        liquidityUsd: pair.liquidity,
        topHolderPct: holderData.topHolderPct,
        holderCount: holderData.holderCount,
        ageHours,
        rugcheckScore: rugScore,
        priceUsd: pair.current_price,
        poolAddress: pair.address,
        dexId: 'meteora',
      }

      // 6. Match strategy
      const strategy = getStrategyForToken(metrics)
      if (!strategy) {
        console.log(`[scanner] ${symbol} — no strategy matched (mc=$${metrics.mcUsd}, vol=$${metrics.volume24h}, holders=${metrics.holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`)
        continue
      }

      // 7. Score
      const score = scoreCandidate(metrics)

      // 8. Persist
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
      console.log(`[scanner] candidate: ${symbol} → ${strategy.id} (score: ${score})`)

      await sendAlert({
        type: 'candidate_found',
        symbol,
        strategy: strategy.id,
        score,
        mcUsd: metrics.mcUsd,
        volume24h: metrics.volume24h,
      })

      // 9. Open position if score high enough
      if (score >= MIN_SCORE_TO_OPEN) {
        const positionId = await openPosition(metrics, strategy)
        if (positionId) {
          openedCount++
          await sendAlert({
            type: 'position_opened',
            symbol,
            strategy: strategy.id,
            solDeposited: strategy.position.maxSolPerPosition,
            entryPrice: metrics.priceUsd,
          })
        }
      }
    } catch (err) {
      console.error(`[scanner] error processing ${pair.name}:`, err)
    }
  }

  console.log(`[scanner] done. candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: preFiltered.length, candidates: candidateCount, opened: openedCount }
}

// ---------------------------------------------------------------------------
// Meteora API fetcher — paginate through all active DLMM pairs
// ---------------------------------------------------------------------------

async function fetchMeteoraPairs(): Promise<MeteoraPair[]> {
  try {
    const allPairs: MeteoraPair[] = []
    let page = 0
    const limit = 100

    while (true) {
      const res = await axios.get<MeteoraPair[]>(
        `${METEORA_API}/pair/all_with_pagination`,
        {
          params: { page, limit, sort_key: 'trade_volume_24h', order_by: 'desc' },
          timeout: 15_000,
        }
      )

      const pairs = res.data ?? []
      allPairs.push(...pairs)

      // Stop if we have enough high-volume pairs or reached end
      if (pairs.length < limit || allPairs.length >= 500) break

      // Also stop once volume drops below our minimum — sorted by volume desc
      const lastPair = pairs[pairs.length - 1]
      if ((lastPair?.trade_volume_24h ?? 0) < PRE_FILTER.minVolume24hUsd) break

      page++
    }

    return allPairs
  } catch (err) {
    console.error('[scanner] Meteora API fetch failed:', err)
    return []
  }
}

// ---------------------------------------------------------------------------
// DexScreener enrichment — get MC and age for a token address
// ---------------------------------------------------------------------------

async function fetchDexScreenerEnrichment(
  tokenAddress: string
): Promise<{ mcUsd: number; ageHours: number } | null> {
  try {
    const res = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { timeout: 8_000 }
    )
    const pairs = res.data?.pairs ?? []
    if (pairs.length === 0) return null

    // Use the pair with highest liquidity as reference
    const best = pairs.sort((a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
      (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)
    )[0]

    const mcUsd = best.marketCap ?? best.fdv ?? 0
    const ageHours = best.pairCreatedAt
      ? (Date.now() - best.pairCreatedAt) / (1000 * 60 * 60)
      : 999

    return { mcUsd, ageHours }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pre-filter — Meteora data only, no external calls
// ---------------------------------------------------------------------------

function applyPreFilter(pair: MeteoraPair): boolean {
  const ageHours = pair.created_at
    ? (Date.now() - new Date(pair.created_at).getTime()) / (1000 * 60 * 60)
    : 0 // unknown age — let it through, DexScreener will clarify

  return (
    pair.trade_volume_24h >= PRE_FILTER.minVolume24hUsd &&
    pair.liquidity >= PRE_FILTER.minLiquidityUsd &&
    pair.liquidity <= PRE_FILTER.maxLiquidityUsd &&
    (ageHours === 0 || ageHours <= PRE_FILTER.maxAgeHours)
  )
}
