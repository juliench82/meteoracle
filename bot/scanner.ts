import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { TokenMetrics } from '@/lib/types'

// ---------------------------------------------------------------------------
// Meteora API — current live base (dlmm-api.meteora.ag is deprecated)
// Docs: https://docs.meteora.ag/api-reference/dlmm/overview
// ---------------------------------------------------------------------------
const METEORA_API = 'https://app.meteora.ag/clmm-api'

const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 50_000_000,
  maxAgeHours: 72,
}

const MIN_SCORE_TO_OPEN = parseInt(process.env.MIN_SCORE_TO_OPEN ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')

// ---------------------------------------------------------------------------
// Meteora pool shape — /pools response
// ---------------------------------------------------------------------------
interface MeteoraPool {
  pool_address: string
  pool_name: string          // e.g. "BONK-SOL"
  token_a_mint: string       // base token
  token_b_mint: string       // quote token
  token_a_symbol: string
  token_b_symbol: string
  pool_tvl: number           // USD liquidity
  trading_volume: number     // 24h volume USD
  fee_rate: number           // e.g. 0.003
  current_price: number
  pool_apr: number
  pool_apy: number
  created_at?: string
  bin_step?: number
}

interface MeteoraPoolsResponse {
  data: MeteoraPool[]
  total: number
  page: number
  page_size: number
}

export async function runScanner(): Promise<{
  scanned: number
  candidates: number
  opened: number
  error?: string
}> {
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

  // 1. Fetch Meteora pools
  const { pools, error: fetchError } = await fetchMeteoraPools()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return { scanned: 0, candidates: 0, opened: 0, error: fetchError }
  }
  console.log(`[scanner] fetched ${pools.length} pools from Meteora`)

  // 2. Pre-filter
  const preFiltered = pools.filter(applyPreFilter)
  console.log(`[scanner] ${preFiltered.length} passed pre-filter`)

  let candidateCount = 0
  let openedCount = 0

  for (const pool of preFiltered) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    try {
      const tokenAddress = pool.token_a_mint
      const symbol = pool.token_a_symbol ?? pool.pool_name.split('-')[0]

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

      // 3. DexScreener enrichment (MC + token age)
      const dexData = await fetchDexScreenerEnrichment(tokenAddress)

      // 4. Helius holder data
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      // 5. Rugcheck
      const rugScore = await checkRugscore(tokenAddress)

      const ageHours = pool.created_at
        ? (Date.now() - new Date(pool.created_at).getTime()) / (1000 * 60 * 60)
        : (dexData?.ageHours ?? 999)

      const metrics: TokenMetrics = {
        address: tokenAddress,
        symbol,
        mcUsd: dexData?.mcUsd ?? 0,
        volume24h: pool.trading_volume,
        liquidityUsd: pool.pool_tvl,
        topHolderPct: holderData.topHolderPct,
        holderCount: holderData.holderCount,
        ageHours,
        rugcheckScore: rugScore,
        priceUsd: pool.current_price,
        poolAddress: pool.pool_address,
        dexId: 'meteora',
      }

      // 6. Match strategy
      const strategy = getStrategyForToken(metrics)
      if (!strategy) {
        console.log(
          `[scanner] ${symbol} — no strategy matched` +
          ` (mc=$${metrics.mcUsd.toFixed(0)}, vol=$${metrics.volume24h.toFixed(0)},` +
          ` holders=${metrics.holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`
        )
        continue
      }

      // 7. Score
      const score = scoreCandidate(metrics)

      // 8. Persist candidate
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

      // 9. Open position if score clears threshold
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
      console.error(`[scanner] error processing ${pool.pool_name}:`, err)
    }
  }

  console.log(`[scanner] done — scanned: ${preFiltered.length}, candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: preFiltered.length, candidates: candidateCount, opened: openedCount }
}

// ---------------------------------------------------------------------------
// Meteora pool fetcher
// GET /pools?page=0&page_size=100&sort_key=trading_volume&order_by=desc
// ---------------------------------------------------------------------------
async function fetchMeteoraPools(): Promise<{ pools: MeteoraPool[]; error?: string }> {
  const allPools: MeteoraPool[] = []
  let page = 0
  const pageSize = 100

  try {
    while (true) {
      const res = await axios.get<MeteoraPoolsResponse>(
        `${METEORA_API}/pools`,
        {
          params: {
            page,
            page_size: pageSize,
            sort_key: 'trading_volume',
            order_by: 'desc',
          },
          timeout: 15_000,
        }
      )

      const pools: MeteoraPool[] = res.data?.data ?? []
      allPools.push(...pools)

      // Early exit: sorted by volume, stop when volume drops below minimum
      const lastPool = pools[pools.length - 1]
      if (
        pools.length < pageSize ||
        allPools.length >= 500 ||
        (lastPool?.trading_volume ?? 0) < PRE_FILTER.minVolume24hUsd
      ) break

      page++
    }

    return { pools: allPools }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    // Surface the HTTP status if available
    const status = (err as { response?: { status?: number } })?.response?.status
    const detail = status ? `HTTP ${status}: ${message}` : message
    return { pools: [], error: `Meteora API failed — ${detail}` }
  }
}

// ---------------------------------------------------------------------------
// DexScreener enrichment — MC and token age only
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

    const best = [...pairs].sort(
      (a: { liquidity?: { usd?: number } }, b: { liquidity?: { usd?: number } }) =>
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
// Pre-filter — uses Meteora data only, zero external calls
// ---------------------------------------------------------------------------
function applyPreFilter(pool: MeteoraPool): boolean {
  const ageHours = pool.created_at
    ? (Date.now() - new Date(pool.created_at).getTime()) / (1000 * 60 * 60)
    : 0 // unknown age — let through, DexScreener will validate

  return (
    pool.trading_volume >= PRE_FILTER.minVolume24hUsd &&
    pool.pool_tvl >= PRE_FILTER.minLiquidityUsd &&
    pool.pool_tvl <= PRE_FILTER.maxLiquidityUsd &&
    (ageHours === 0 || ageHours <= PRE_FILTER.maxAgeHours)
  )
}
