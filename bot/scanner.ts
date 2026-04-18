import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { STRATEGIES, getStrategyForToken, classifyToken } from '@/strategies'
import { scoreCandidate } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { checkRugscore } from '@/lib/rugcheck'
import { detectOrphanedPositions } from './orphan-detector'
import { fetchBondingCurve, isPumpFunToken } from '@/lib/pumpfun'
import type { TokenMetrics } from '@/lib/types'

const METEORA_DATAPI  = 'https://dlmm.datapi.meteora.ag'
const METEORA_DLMM    = 'https://dlmm-api.meteora.ag'
const DEXSCREENER     = 'https://api.dexscreener.com/latest/dex/tokens'

// Pre-filter: broad pass to limit API cost — strategy filters are the real gate
const PRE_FILTER = {
  minVolume24hUsd: 10_000,
  minLiquidityUsd: 10_000,
  maxLiquidityUsd: 500_000_000, // raised: allow deep Stable Farm pools
  maxAgeHours:     999_999,     // no age cap here — strategies enforce their own
}

const CHEAP_FILTER = {
  minMcUsd:    100_000,
  maxMcUsd: 500_000_000, // raised: allow large-cap tokens for Stable Farm
  minVol24h:    10_000,  // lowered: pre-filter already gates on 10k, avoid double-filtering
  minLiqUsd:    10_000,
  maxAgeHours:  999_999, // no age cap — strategies enforce their own
}

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')
const SCAN_INTERVAL_MS         = parseInt(process.env.LP_SCAN_INTERVAL_SEC     ?? '900') * 1_000
const WSOL = 'So11111111111111111111111111111111111111112'
const SUPABASE_TIMEOUT_MS = 10_000
const METEORA_FETCH_TIMEOUT_MS = 45_000

interface MeteoraPool {
  address: string; name: string; created_at: number; tvl: number; current_price: number
  volume: { '24h': number; '1h': number }
  fees: { '24h': number }
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

async function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T | null> {
  let timerId: ReturnType<typeof setTimeout>
  const timer = new Promise<null>((resolve) => {
    timerId = setTimeout(() => {
      console.warn(`[scanner] timeout (${ms}ms): ${label}`)
      resolve(null)
    }, ms)
  })
  const result = await Promise.race([Promise.resolve(promise), timer])
  clearTimeout(timerId!)
  return result
}

function explainNoStrategy(t: TokenMetrics): string {
  const perStrat = STRATEGIES.filter(s => s.enabled).map(s => {
    const f = s.filters
    const fails: string[] = []
    if (t.mcUsd        < f.minMcUsd)          fails.push(`mc=$${t.mcUsd.toFixed(0)}<$${f.minMcUsd}`)
    if (t.mcUsd        > f.maxMcUsd)          fails.push(`mc too high`)
    if (t.volume24h    < f.minVolume24h)       fails.push(`vol=$${t.volume24h.toFixed(0)}<$${f.minVolume24h}`)
    if (t.liquidityUsd < f.minLiquidityUsd)   fails.push(`liq=$${t.liquidityUsd.toFixed(0)}<$${f.minLiquidityUsd}`)
    if (t.topHolderPct > f.maxTopHolderPct)   fails.push(`topHolder=${t.topHolderPct.toFixed(1)}%>${f.maxTopHolderPct}%`)
    if (t.holderCount  < f.minHolderCount)    fails.push(`holders=${t.holderCount}<${f.minHolderCount}`)
    if (t.ageHours     > f.maxAgeHours)       fails.push(`age=${t.ageHours.toFixed(1)}h>${f.maxAgeHours}h`)
    if (t.rugcheckScore < f.minRugcheckScore) fails.push(`rug=${t.rugcheckScore}<${f.minRugcheckScore}`)
    return fails.length === 0 ? null : `[${s.id}: ${fails.join(', ')}]`
  }).filter(Boolean)
  return perStrat.join(' | ') || 'all strategies disabled'
}

let _orphanCheckDone = false

export async function runScanner(): Promise<{
  scanned: number; candidates: number; opened: number; error?: string
}> {
  const state = await getBotState()
  if (!state.enabled) {
    console.log('[scanner] bot is stopped — skipping tick')
    return { scanned: 0, candidates: 0, opened: 0 }
  }

  console.log('[scanner] step 1/4 — fetching Meteora pools')
  const { pools, error: fetchError } = await fetchMeteoraPools()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return { scanned: 0, candidates: 0, opened: 0, error: fetchError }
  }
  console.log(`[scanner] step 1/4 — got ${pools.length} pools`)

  if (!_orphanCheckDone) {
    _orphanCheckDone = true
    const poolAddresses = pools.map(p => p.address)
    detectOrphanedPositions(poolAddresses).catch(err =>
      console.warn('[scanner] orphan detector error:', err)
    )
  }

  console.log('[scanner] step 2/4 — cheap pre-screen')
  const survivors: Array<{ pool: MeteoraPool; mcUsd: number; ageHours: number }> = []

  for (const pool of pools) {
    const isXSol   = pool.token_x.address === WSOL
    const token    = isXSol ? pool.token_y : pool.token_x
    const symbol   = pool.name ?? token.symbol
    const vol24h   = pool.volume['24h']
    const liqUsd   = pool.tvl
    const mcUsd    = token.market_cap ?? 0
    const ageHours = pool.created_at
      ? (Date.now() / 1000 - toUnixSeconds(pool.created_at)) / 3600
      : 0

    if (mcUsd    < CHEAP_FILTER.minMcUsd)  { console.log(`[scanner] ${symbol} — skip: mc=$${mcUsd.toFixed(0)} < $${CHEAP_FILTER.minMcUsd}`); continue }
    if (mcUsd    > CHEAP_FILTER.maxMcUsd)  { console.log(`[scanner] ${symbol} — skip: mc too high`); continue }
    if (vol24h   < CHEAP_FILTER.minVol24h) { console.log(`[scanner] ${symbol} — skip: vol=$${vol24h.toFixed(0)} < $${CHEAP_FILTER.minVol24h}`); continue }
    if (liqUsd   < CHEAP_FILTER.minLiqUsd) { console.log(`[scanner] ${symbol} — skip: liq=$${liqUsd.toFixed(0)} < $${CHEAP_FILTER.minLiqUsd}`); continue }

    console.log(`[scanner] ${symbol} — passed cheap filter (mc=$${mcUsd.toFixed(0)}, vol=$${vol24h.toFixed(0)}, liq=$${liqUsd.toFixed(0)}, age=${ageHours.toFixed(1)}h)`)
    survivors.push({ pool, mcUsd, ageHours })
  }
  console.log(`[scanner] step 2/4 — ${survivors.length}/${pools.length} passed cheap filter`)

  if (survivors.length === 0) {
    console.log('[scanner] done — no survivors')
    return { scanned: pools.length, candidates: 0, opened: 0 }
  }

  console.log('[scanner] step 3/4 — Supabase dedup check')
  const supabase = createServerClient()

  const countResult = await withTimeout(
    supabase.from('lp_positions').select('id', { count: 'exact', head: true }).in('status', ['active', 'out_of_range']),
    SUPABASE_TIMEOUT_MS, 'lp_positions count'
  )
  const openCount = countResult?.count ?? 0
  if (openCount >= MAX_CONCURRENT_POSITIONS) {
    console.log(`[scanner] max LP positions reached (${openCount}/${MAX_CONCURRENT_POSITIONS})`)
    return { scanned: pools.length, candidates: 0, opened: 0 }
  }

  console.log('[scanner] step 4/4 — deep checks on survivors')
  let candidateCount = 0
  let openedCount    = 0

  const heliusRpcUrl = process.env.HELIUS_RPC_URL ?? ''

  for (const { pool, mcUsd, ageHours } of survivors) {
    const isXSol       = pool.token_x.address === WSOL
    const token        = isXSol ? pool.token_y : pool.token_x
    const tokenAddress = token.address
    const symbol       = pool.name ?? token.symbol
    const vol24h       = pool.volume['24h']
    const vol1h        = pool.volume['1h']
    const liqUsd       = pool.tvl

    const recentResult = await withTimeout(
      supabase.from('candidates').select('id').eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - 60 * 60 * 1000).toISOString()).limit(1),
      SUPABASE_TIMEOUT_MS, `candidates dedup ${symbol}`
    )
    if (recentResult?.data && recentResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: scanned in last 1h`); continue }

    const posResult = await withTimeout(
      supabase.from('lp_positions').select('id').eq('mint', tokenAddress)
        .in('status', ['active', 'out_of_range']).limit(1),
      SUPABASE_TIMEOUT_MS, `lp_positions dedup ${symbol}`
    )
    if (posResult?.data && posResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: open LP position exists`); continue }

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

    const holderCountForFilter = holderCount > 0 ? holderCount : (token.holders ?? 0)

    let bondingCurvePct: number | undefined = undefined
    if (isPumpFunToken(tokenAddress) && heliusRpcUrl) {
      const curve = await fetchBondingCurve(tokenAddress, heliusRpcUrl)
      bondingCurvePct = curve?.progressPct ?? undefined
      if (bondingCurvePct !== undefined) {
        console.log(`[pumpfun] ${symbol} bonding curve: ${bondingCurvePct.toFixed(1)}% (complete=${curve?.complete})`)
      }
    }

    const metrics: TokenMetrics = {
      address: tokenAddress, symbol, mcUsd: resolvedMc,
      volume24h: vol24h, liquidityUsd: liqUsd,
      topHolderPct, holderCount: holderCountForFilter, ageHours,
      rugcheckScore: rugScore, priceUsd: token.price,
      poolAddress: pool.address, dexId: 'meteora',
      bondingCurvePct,
    }

    const tokenClass = classifyToken({
      address:      metrics.address,
      mcUsd:        metrics.mcUsd,
      volume24h:    metrics.volume24h,
      volume1h:     vol1h,
      liquidityUsd: metrics.liquidityUsd,
      ageHours:     metrics.ageHours,
      topHolderPct: metrics.topHolderPct,
      holderCount:  metrics.holderCount,
      rugcheckScore: metrics.rugcheckScore,
    })

    const strategy = getStrategyForToken({ ...metrics, volume1h: vol1h })
    if (!strategy) {
      console.log(`[scanner] ${symbol} — no strategy (class=${tokenClass}): ${explainNoStrategy(metrics)}`)
      continue
    }

    const score = scoreCandidate(metrics)
    const bondingInfo = bondingCurvePct !== undefined ? `, curve=${bondingCurvePct.toFixed(1)}%` : ''

    await withTimeout(
      supabase.from('candidates').insert({
        token_address:    metrics.address,
        symbol:           metrics.symbol,
        score,
        strategy_matched: strategy.id,
        strategy_id:      strategy.id,
        token_class:      tokenClass,
        mc_at_scan:       metrics.mcUsd,
        volume_24h:       metrics.volume24h,
        holder_count:     metrics.holderCount,
        rugcheck_score:   metrics.rugcheckScore,
        top_holder_pct:   metrics.topHolderPct,
        scanned_at:       new Date().toISOString(),
      }),
      SUPABASE_TIMEOUT_MS, `candidates insert ${symbol}`
    )

    candidateCount++
    console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (class=${tokenClass}, score=${score}, mc=$${resolvedMc.toFixed(0)}, vol=$${vol24h.toFixed(0)}, holders=${holderCountForFilter}, rug=${rugScore}, age=${ageHours.toFixed(1)}h${bondingInfo})`)
    await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct })

    if (score >= MIN_SCORE_TO_OPEN) {
      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        await sendAlert({ type: 'position_opened', symbol, strategy: strategy.id, solDeposited: strategy.position.maxSolPerPosition, entryPrice: metrics.priceUsd, positionId })
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

async function fetchMeteoraPoolsFromEndpoint(baseUrl: string): Promise<MeteoraPool[]> {
  // Fetch up to 3 pages to surface large-cap pools buried by volume sort
  const allPools: MeteoraPool[] = []
  for (let page = 1; page <= 3; page++) {
    try {
      const res = await axios.get<PoolsResponse>(`${baseUrl}/pools`, {
        params: { page, page_size: 1000, sort_by: 'volume_24h:desc' },
        timeout: METEORA_FETCH_TIMEOUT_MS,
      })
      const data = res.data?.data ?? []
      allPools.push(...data)
      if (data.length < 1000) break // last page
    } catch {
      break
    }
  }
  return allPools
}

async function fetchMeteoraPools(): Promise<{ pools: MeteoraPool[]; error?: string }> {
  let allPools: MeteoraPool[] = []

  for (const endpoint of [METEORA_DATAPI, METEORA_DLMM]) {
    try {
      console.log(`[scanner] trying Meteora endpoint: ${endpoint}`)
      allPools = await fetchMeteoraPoolsFromEndpoint(endpoint)
      if (allPools.length > 0) {
        console.log(`[scanner] ${endpoint} returned ${allPools.length} pools`)
        break
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status  = (err as { response?: { status?: number } })?.response?.status
      console.warn(`[scanner] endpoint ${endpoint} failed: ${status ? `HTTP ${status}: ` : ''}${message}`)
    }
  }

  if (allPools.length === 0) {
    return { pools: [], error: 'All Meteora endpoints failed or returned empty' }
  }

  const pools = allPools.filter((p) => {
    if (p.is_blacklisted) return false
    if (p.volume['24h'] < PRE_FILTER.minVolume24hUsd) return false
    if (p.tvl < PRE_FILTER.minLiquidityUsd) return false
    if (p.tvl > PRE_FILTER.maxLiquidityUsd) return false
    const hasSol = p.token_x.address === WSOL || p.token_y.address === WSOL
    if (!hasSol) return false
    return true
  })

  console.log(`[scanner] ${allPools.length} pools fetched; ${pools.length} passed JS pre-filter`)
  return { pools }
}

// ─── Standalone entrypoint (PM2) ──────────────────────────────────────────────

const standaloneScannerTick = async (): Promise<void> => {
  const label = '[lp-scanner]'
  try {
    const result = await runScanner()
    console.log(`${label} tick done — scanned=${result.scanned} candidates=${result.candidates} opened=${result.opened}`)
  } catch (err) {
    console.error(`${label} tick error:`, err)
  }
}

if (require.main === module || process.env.LP_SCANNER_STANDALONE === 'true') {
  const label = '[lp-scanner]'
  console.log(`${label} starting — poll every ${SCAN_INTERVAL_MS / 1000}s`)
  standaloneScannerTick().then(() => setInterval(standaloneScannerTick, SCAN_INTERVAL_MS))
}
