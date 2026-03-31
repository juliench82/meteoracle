import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getStrategyForToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import type { TokenMetrics } from '@/lib/types'

const METEORA_API = 'https://dlmm.datapi.meteora.ag'
const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens'

const PRE_FILTER = {
  minVolume24hUsd: 50_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 50_000_000,
  maxAgeHours:     72,
}

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')
const WSOL = 'So11111111111111111111111111111111111111112'
const BATCH_SIZE = 8

interface MeteoraPool {
  address:       string
  name:          string
  created_at:    number
  tvl:           number
  current_price: number
  volume: { '24h': number; '1h': number }
  fees:   { '24h': number }
  fee_tvl_ratio: { '24h': number }
  pool_config: { bin_step: number; base_fee_pct: number }
  token_x: { address: string; symbol: string; decimals: number; holders: number; market_cap: number; price: number }
  token_y: { address: string; symbol: string; decimals: number; holders: number; market_cap: number; price: number }
  is_blacklisted: boolean
}

interface PoolsResponse {
  current_page: number
  pages:        number
  page_size:    number
  total:        number
  data:         MeteoraPool[]
}

/** Normalise a Meteora created_at timestamp to unix seconds.
 *  The API has been observed returning both seconds and milliseconds. */
function toUnixSeconds(ts: number): number {
  // If ts > 1e10, it's almost certainly milliseconds (year 2001+ in ms = ~1e12)
  return ts > 1e10 ? ts / 1000 : ts
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

  for (let i = 0; i < pools.length; i += BATCH_SIZE) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    const batch = pools.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map((pool) => processPool(pool, supabase))
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        candidateCount++
        if (result.value.opened) openedCount++
      }
    }
  }

  console.log(`[scanner] done — scanned: ${pools.length}, candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: pools.length, candidates: candidateCount, opened: openedCount }
}

async function processPool(
  pool:     MeteoraPool,
  supabase: ReturnType<typeof createServerClient>,
): Promise<{ opened: boolean } | null> {
  const isXSol       = pool.token_x.address === WSOL
  const token        = isXSol ? pool.token_y : pool.token_x
  const tokenAddress = token.address
  const symbol       = pool.name ?? token.symbol

  const { data: existing } = await supabase
    .from('candidates')
    .select('id')
    .eq('token_address', tokenAddress)
    .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .limit(1)
  if (existing && existing.length > 0) {
    console.log(`[scanner] ${symbol} — skip: scanned in last 1h`)
    return null
  }

  const { data: existingPosition } = await supabase
    .from('positions')
    .select('id')
    .eq('token_address', tokenAddress)
    .in('status', ['active', 'out_of_range'])
    .limit(1)
  if (existingPosition && existingPosition.length > 0) {
    console.log(`[scanner] ${symbol} — skip: open position exists`)
    return null
  }

  let mcUsd = token.market_cap ?? 0
  if (!mcUsd || mcUsd < 1) {
    mcUsd = await fetchMcFromDexScreener(tokenAddress, token.price)
    if (!mcUsd || mcUsd < 1) {
      console.log(`[scanner] ${symbol} — skip: could not resolve market_cap`)
      return null
    }
  }

  const [holderData, rugScore] = await Promise.all([
    checkHolders(tokenAddress),
    checkRugscore(tokenAddress),
  ])

  let holderCount  = holderData.holderCount
  let topHolderPct = holderData.topHolderPct
  if (!holderData.reliable) {
    const meteoraHolders = token.holders ?? 0
    if (meteoraHolders > holderCount) holderCount = meteoraHolders
  }

  // Normalise created_at: Meteora returns seconds OR milliseconds
  const createdAtSec = toUnixSeconds(pool.created_at)
  const ageHours     = (Date.now() / 1000 - createdAtSec) / 3600
  const vol24h       = pool.volume['24h']
  const liqUsd       = pool.tvl

  const metrics: TokenMetrics = {
    address:       tokenAddress,
    symbol,
    mcUsd,
    volume24h:     vol24h,
    liquidityUsd:  liqUsd,
    topHolderPct,
    holderCount,
    ageHours,
    rugcheckScore: rugScore,
    priceUsd:      token.price,
    poolAddress:   pool.address,
    dexId:         'meteora',
  }

  const strategy = getStrategyForToken(metrics)

  if (!strategy) {
    const reasons: string[] = []
    if (mcUsd    < 200_000)    reasons.push(`mc=$${mcUsd.toFixed(0)} < $200K`)
    if (mcUsd    > 50_000_000) reasons.push(`mc=$${mcUsd.toFixed(0)} > $50M`)
    if (vol24h   < 100_000)    reasons.push(`vol=$${vol24h.toFixed(0)} < $100K`)
    if (liqUsd   < 50_000)     reasons.push(`liq=$${liqUsd.toFixed(0)} < $50K`)
    if (topHolderPct > 15)     reasons.push(`topHolder=${topHolderPct.toFixed(1)}% > 15%`)
    if (holderCount  < 500)    reasons.push(`holders=${holderCount} < 500`)
    if (ageHours     > 72)     reasons.push(`age=${ageHours.toFixed(1)}h > 72h`)
    if (rugScore     < 60)     reasons.push(`rug=${rugScore} < 60`)
    const why = reasons.length > 0 ? reasons.join(', ') : 'unknown (check strategy router)'
    console.log(`[scanner] ${symbol} — no strategy: ${why}`)
    return null
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

  console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (score=${score}, mc=$${mcUsd.toFixed(0)}, vol=$${vol24h.toFixed(0)}, holders=${holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`)

  await sendAlert({
    type:      'candidate_found',
    symbol,
    strategy:  strategy.id,
    score,
    mcUsd:     metrics.mcUsd,
    volume24h: metrics.volume24h,
  })

  let opened = false
  if (score >= MIN_SCORE_TO_OPEN) {
    const positionId = await openPosition(metrics, strategy)
    if (positionId) {
      opened = true
      await sendAlert({
        type:         'position_opened',
        symbol,
        strategy:     strategy.id,
        solDeposited: strategy.position.maxSolPerPosition,
        entryPrice:   metrics.priceUsd,
      })
    }
  }

  return { opened }
}

async function fetchMcFromDexScreener(mint: string, fallbackPrice: number): Promise<number> {
  try {
    const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6_000 })
    const pairs: Array<{ fdv?: number; marketCap?: number }> = res.data?.pairs ?? []
    if (pairs.length === 0) return 0
    const best = pairs[0]
    return best.marketCap ?? best.fdv ?? 0
  } catch (err) {
    console.warn(`[scanner] DexScreener MC fallback failed for ${mint}:`, err)
    return 0
  }
}

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
    const maxAgeSeconds = PRE_FILTER.maxAgeHours * 3600
    const now = Date.now() / 1000
    const pools = allPools.filter((p) => {
      if (!p.created_at) return false
      const createdSec = toUnixSeconds(p.created_at)
      return (now - createdSec) <= maxAgeSeconds
    })

    console.log(`[scanner] datapi returned ${allPools.length} pools; ${pools.length} within ${PRE_FILTER.maxAgeHours}h age window`)
    return { pools }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = (err as { response?: { status?: number } })?.response?.status
    const detail  = status ? `HTTP ${status}: ${message}` : message
    return { pools: [], error: `Meteora datapi failed — ${detail}` }
  }
}
