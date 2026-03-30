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
// Meteora DLMM Data API  (NEW — as of 2025)
// Base:  https://dlmm.datapi.meteora.ag
// Docs:  https://docs.meteora.ag/api-reference/dlmm
// ---------------------------------------------------------------------------
const METEORA_API = 'https://dlmm.datapi.meteora.ag'

const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 50_000_000,
  maxAgeHours:     72,
}

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')
const WSOL = 'So11111111111111111111111111111111111111112'

// Shape returned by GET /pools (subset we use)
interface MeteoraPool {
  address:       string
  name:          string
  created_at:    number          // unix seconds
  tvl:           number
  current_price: number
  volume: {
    '24h': number
    '1h':  number
  }
  fees: {
    '24h': number
  }
  fee_tvl_ratio: {
    '24h': number
  }
  pool_config: {
    bin_step:      number
    base_fee_pct:  number
  }
  token_x: {
    address:   string
    symbol:    string
    decimals:  number
    holders:   number
    market_cap: number
    price:     number
  }
  token_y: {
    address:   string
    symbol:    string
    decimals:  number
    holders:   number
    market_cap: number
    price:     number
  }
  is_blacklisted: boolean
}

interface PoolsResponse {
  current_page: number
  pages:        number
  page_size:    number
  total:        number
  data:         MeteoraPool[]
}

export async function runScanner(): Promise<{
  scanned:    number
  candidates: number
  opened:     number
  error?:     string
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

  const { pools, error: fetchError } = await fetchMeteoraPools()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return { scanned: 0, candidates: 0, opened: 0, error: fetchError }
  }
  console.log(`[scanner] fetched ${pools.length} pools from Meteora datapi`)

  let candidateCount = 0
  let openedCount    = 0

  for (const pool of pools) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    try {
      // Identify the non-SOL token side
      const isXSol    = pool.token_x.address === WSOL
      const token     = isXSol ? pool.token_y : pool.token_x
      const tokenAddress = token.address
      const symbol       = token.symbol

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

      // Holder data (Helius) — API already has `holders` but we still need topHolderPct
      const holderData = await checkHolders(tokenAddress)
      if (!holderData) continue

      const rugScore = await checkRugscore(tokenAddress)

      const ageHours = (Date.now() / 1000 - pool.created_at) / 3600

      const metrics: TokenMetrics = {
        address:       tokenAddress,
        symbol,
        mcUsd:         token.market_cap ?? 0,
        volume24h:     pool.volume['24h'],
        liquidityUsd:  pool.tvl,
        topHolderPct:  holderData.topHolderPct,
        holderCount:   holderData.holderCount,
        ageHours,
        rugcheckScore: rugScore,
        priceUsd:      token.price,
        poolAddress:   pool.address,
        dexId:         'meteora',
      }

      const strategy = getStrategyForToken(metrics)
      if (!strategy) {
        console.log(
          `[scanner] ${symbol} — no strategy matched` +
          ` (mc=$${metrics.mcUsd.toFixed(0)}, vol=$${metrics.volume24h.toFixed(0)},` +
          ` holders=${metrics.holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`
        )
        continue
      }

      const score = scoreCandidate(metrics)

      await supabase.from('candidates').insert({
        token_address:    metrics.address,
        symbol:           metrics.symbol,
        score,
        strategy_matched: strategy.id,
        mc_at_scan:       metrics.mcUsd,
        volume_24h:       metrics.volume24h,
        holder_count:     metrics.holderCount,
        rugcheck_score:   metrics.rugcheckScore,
        top_holder_pct:   metrics.topHolderPct,
        scanned_at:       new Date().toISOString(),
      })

      candidateCount++
      console.log(`[scanner] candidate: ${symbol} → ${strategy.id} (score: ${score})`)

      await sendAlert({
        type:      'candidate_found',
        symbol,
        strategy:  strategy.id,
        score,
        mcUsd:     metrics.mcUsd,
        volume24h: metrics.volume24h,
      })

      if (score >= MIN_SCORE_TO_OPEN) {
        const positionId = await openPosition(metrics, strategy)
        if (positionId) {
          openedCount++
          await sendAlert({
            type:         'position_opened',
            symbol,
            strategy:     strategy.id,
            solDeposited: strategy.position.maxSolPerPosition,
            entryPrice:   metrics.priceUsd,
          })
        }
      }
    } catch (err) {
      console.error(`[scanner] error processing pool ${pool.address}:`, err)
    }
  }

  console.log(
    `[scanner] done — scanned: ${pools.length}, candidates: ${candidateCount}, opened: ${openedCount}`
  )
  return { scanned: pools.length, candidates: candidateCount, opened: openedCount }
}

// ---------------------------------------------------------------------------
// Fetch pools from Meteora datapi with server-side filtering
// We push as much work as possible to the API to minimise payload size:
//   - is_blacklisted=false
//   - volume_24h >= minVolume24hUsd
//   - tvl >= minLiquidityUsd && tvl <= maxLiquidityUsd
//   - token_y = WSOL  (SOL-quote pools only)
// Age filter is applied client-side since created_at is unix seconds, not a
// range filter supported by the current filter_by syntax.
// ---------------------------------------------------------------------------
async function fetchMeteoraPools(): Promise<{ pools: MeteoraPool[]; error?: string }> {
  const filterBy = [
    'is_blacklisted=false',
    `volume_24h>=${PRE_FILTER.minVolume24hUsd}`,
    `tvl>=${PRE_FILTER.minLiquidityUsd}`,
    `tvl<=${PRE_FILTER.maxLiquidityUsd}`,
    `token_y=${WSOL}`,
  ].join(' && ')

  const params = {
    page:      1,
    page_size: 1000,
    sort_by:   'volume_24h:desc',
    filter_by: filterBy,
  }

  try {
    const res = await axios.get<PoolsResponse>(`${METEORA_API}/pools`, {
      params,
      timeout: 20_000,
    })

    const allPools = res.data?.data ?? []

    // Client-side age filter (created_at is unix seconds)
    const maxAgeSeconds = PRE_FILTER.maxAgeHours * 3600
    const now = Date.now() / 1000
    const pools = allPools.filter(
      (p) => p.created_at && (now - p.created_at) <= maxAgeSeconds
    )

    console.log(
      `[scanner] datapi returned ${allPools.length} pools; ${pools.length} within ${PRE_FILTER.maxAgeHours}h age window`
    )
    return { pools }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = (err as { response?: { status?: number } })?.response?.status
    const detail  = status ? `HTTP ${status}: ${message}` : message
    return { pools: [], error: `Meteora datapi failed — ${detail}` }
  }
}
