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

// Evil Panda cheap pre-screen thresholds (no external calls needed)
const CHEAP_FILTER = {
  minMcUsd:      200_000,
  maxMcUsd:   50_000_000,
  minVol24h:     100_000,
  minLiqUsd:      50_000,
  maxAgeHours:        72,
}

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')
const WSOL = 'So11111111111111111111111111111111111111112'

interface MeteoraPool {
  address:    string
  name:       string
  created_at: number
  tvl:        number
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
  current_page: number; pages: number; page_size: number; total: number; data: MeteoraPool[]
}

function toUnixSeconds(ts: number): number {
  return ts > 1e10 ? ts / 1000 : ts
}

export async function runScanner(): Promise<{
  scanned: number; candidates: number; opened: number; error?: string
}> {
  console.log('[scanner] step 1/5 — started')
  const supabase = createServerClient()

  console.log('[scanner] step 2/5 — checking open positions')
  const { count: openCount, error: countErr } = await supabase
    .from('positions')
    .select('id', { count: 'exact', head: true })
    .in('status', ['active', 'out_of_range'])

  if (countErr) console.warn('[scanner] position count error:', countErr.message)

  if ((openCount ?? 0) >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[scanner] max positions reached (${openCount}/${MAX_CONCURRENT_POSITIONS})`)
    return { scanned: 0, candidates: 0, opened: 0 }
  }

  console.log('[scanner] step 3/5 — fetching Meteora pools')
  const { pools, error: fetchError } = await fetchMeteoraPools()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return { scanned: 0, candidates: 0, opened: 0, error: fetchError }
  }
  console.log(`[scanner] step 3/5 — got ${pools.length} pools`)

  // ── Phase 1: cheap pre-screen (no external API calls) ──────────────────
  console.log('[scanner] step 4/5 — cheap pre-screen')
  const survivors: Array<{ pool: MeteoraPool; mcUsd: number; ageHours: number }> = []

  for (const pool of pools) {
    const isXSol  = pool.token_x.address === WSOL
    const token   = isXSol ? pool.token_y : pool.token_x
    const symbol  = pool.name ?? token.symbol
    const vol24h  = pool.volume['24h']
    const liqUsd  = pool.tvl
    const mcUsd   = token.market_cap ?? 0
    const createdAtSec = toUnixSeconds(pool.created_at)
    const ageHours     = (Date.now() / 1000 - createdAtSec) / 3600

    if (mcUsd   < CHEAP_FILTER.minMcUsd)   { console.log(`[scanner] ${symbol} — cheap skip: mc=$${mcUsd.toFixed(0)} < $${CHEAP_FILTER.minMcUsd}`); continue }
    if (mcUsd   > CHEAP_FILTER.maxMcUsd)   { console.log(`[scanner] ${symbol} — cheap skip: mc=$${mcUsd.toFixed(0)} > $${(CHEAP_FILTER.maxMcUsd/1e6).toFixed(0)}M`); continue }
    if (vol24h  < CHEAP_FILTER.minVol24h)  { console.log(`[scanner] ${symbol} — cheap skip: vol=$${vol24h.toFixed(0)} < $${CHEAP_FILTER.minVol24h}`); continue }
    if (liqUsd  < CHEAP_FILTER.minLiqUsd)  { console.log(`[scanner] ${symbol} — cheap skip: liq=$${liqUsd.toFixed(0)} < $${CHEAP_FILTER.minLiqUsd}`); continue }
    if (ageHours > CHEAP_FILTER.maxAgeHours) { console.log(`[scanner] ${symbol} — cheap skip: age=${ageHours.toFixed(1)}h > ${CHEAP_FILTER.maxAgeHours}h`); continue }

    console.log(`[scanner] ${symbol} — passed cheap filter (mc=$${mcUsd.toFixed(0)}, vol=$${vol24h.toFixed(0)}, age=${ageHours.toFixed(1)}h)`)
    survivors.push({ pool, mcUsd, ageHours })
  }

  console.log(`[scanner] step 4/5 — ${survivors.length}/${pools.length} pools passed cheap filter`)

  // ── Phase 2: expensive checks only for survivors ───────────────────────
  console.log('[scanner] step 5/5 — deep checks on survivors')
  let candidateCount = 0
  let openedCount    = 0

  for (const { pool, mcUsd, ageHours } of survivors) {
    const { count: currentOpen } = await supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range'])
    if ((currentOpen ?? 0) >= MAX_CONCURRENT_POSITIONS) break

    const isXSol       = pool.token_x.address === WSOL
    const token        = isXSol ? pool.token_y : pool.token_x
    const tokenAddress = token.address
    const symbol       = pool.name ?? token.symbol
    const vol24h       = pool.volume['24h']
    const liqUsd       = pool.tvl

    // Skip if scanned recently
    const { data: existing } = await supabase
      .from('candidates').select('id')
      .eq('token_address', tokenAddress)
      .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .limit(1)
    if (existing && existing.length > 0) { console.log(`[scanner] ${symbol} — skip: scanned in last 1h`); continue }

    const { data: existingPos } = await supabase
      .from('positions').select('id')
      .eq('token_address', tokenAddress)
      .in('status', ['active', 'out_of_range'])
      .limit(1)
    if (existingPos && existingPos.length > 0) { console.log(`[scanner] ${symbol} — skip: open position exists`); continue }

    // Resolve mc from DexScreener if Meteora returned 0
    let resolvedMc = mcUsd
    if (!resolvedMc || resolvedMc < 1) {
      resolvedMc = await fetchMcFromDexScreener(tokenAddress, token.price)
      if (!resolvedMc || resolvedMc < 1) { console.log(`[scanner] ${symbol} — skip: no market_cap`); continue }
    }

    console.log(`[scanner] ${symbol} — calling Helius + Rugcheck`)
    const [holderData, rugScore] = await Promise.all([
      checkHolders(tokenAddress),
      checkRugscore(tokenAddress),
    ])

    let holderCount  = holderData.holderCount
    let topHolderPct = holderData.topHolderPct
    if (!holderData.reliable) {
      const mh = token.holders ?? 0
      if (mh > holderCount) holderCount = mh
    }

    const metrics: TokenMetrics = {
      address: tokenAddress, symbol, mcUsd: resolvedMc,
      volume24h: vol24h, liquidityUsd: liqUsd,
      topHolderPct, holderCount, ageHours,
      rugcheckScore: rugScore, priceUsd: token.price,
      poolAddress: pool.address, dexId: 'meteora',
    }

    const strategy = getStrategyForToken(metrics)
    if (!strategy) {
      const reasons: string[] = []
      if (topHolderPct > 15)  reasons.push(`topHolder=${topHolderPct.toFixed(1)}% > 15%`)
      if (holderCount  < 500) reasons.push(`holders=${holderCount} < 500`)
      if (rugScore     < 60)  reasons.push(`rug=${rugScore} < 60`)
      console.log(`[scanner] ${symbol} — no strategy after deep check: ${reasons.join(', ') || 'unknown'}`)
      continue
    }

    const score = scoreCandidate(metrics)
    await supabase.from('candidates').insert({
      token_address: metrics.address, symbol: metrics.symbol, score,
      strategy_matched: strategy.id, mc_at_scan: metrics.mcUsd,
      volume_24h: metrics.volume24h, holder_count: metrics.holderCount,
      rugcheck_score: metrics.rugcheckScore, top_holder_pct: metrics.topHolderPct,
      scanned_at: new Date().toISOString(),
    })

    candidateCount++
    console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (score=${score}, mc=$${resolvedMc.toFixed(0)}, vol=$${vol24h.toFixed(0)}, holders=${holderCount}, rug=${rugScore}, age=${ageHours.toFixed(1)}h)`)

    await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h })

    if (score >= MIN_SCORE_TO_OPEN) {
      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        await sendAlert({ type: 'position_opened', symbol, strategy: strategy.id, solDeposited: strategy.position.maxSolPerPosition, entryPrice: metrics.priceUsd })
      }
    }
  }

  console.log(`[scanner] done — scanned: ${pools.length}, survivors: ${survivors.length}, candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: pools.length, candidates: candidateCount, opened: openedCount }
}

async function fetchMcFromDexScreener(mint: string, fallbackPrice: number): Promise<number> {
  try {
    const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6_000 })
    const pairs: Array<{ fdv?: number; marketCap?: number }> = res.data?.pairs ?? []
    if (pairs.length === 0) return 0
    return pairs[0].marketCap ?? pairs[0].fdv ?? 0
  } catch { return 0 }
}

async function fetchMeteoraPools(): Promise<{ pools: MeteoraPool[]; error?: string }> {
  const filterBy = [
    'is_blacklisted=false',
    `volume_24h>=${PRE_FILTER.minVolume24hUsd}`,
    `tvl>=${PRE_FILTER.minLiquidityUsd}`,
    `tvl<=${PRE_FILTER.maxLiquidityUsd}`,
    `token_y=${WSOL}`,
  ].join(' && ')

  try {
    const res = await axios.get<PoolsResponse>(`${METEORA_API}/pools`, {
      params: { page: 1, page_size: 1000, sort_by: 'volume_24h:desc', filter_by: filterBy },
      timeout: 20_000,
    })
    const allPools = res.data?.data ?? []
    const maxAgeSec = PRE_FILTER.maxAgeHours * 3600
    const now = Date.now() / 1000
    const pools = allPools.filter((p) => p.created_at && (now - toUnixSeconds(p.created_at)) <= maxAgeSec)
    console.log(`[scanner] datapi returned ${allPools.length} pools; ${pools.length} within ${PRE_FILTER.maxAgeHours}h age window`)
    return { pools }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status  = (err as { response?: { status?: number } })?.response?.status
    return { pools: [], error: `Meteora datapi failed — ${status ? `HTTP ${status}: ` : ''}${message}` }
  }
}
