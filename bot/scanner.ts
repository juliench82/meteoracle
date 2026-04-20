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
import { fetchBondingCurve, isPumpFunToken } from '@/lib/pumpfun'
import type { TokenMetrics } from '@/lib/types'

const METEORA_DATAPI  = 'https://dlmm.datapi.meteora.ag'
const METEORA_DLMM    = 'https://dlmm-api.meteora.ag'
const DEXSCREENER     = 'https://api.dexscreener.com/latest/dex/tokens'

const PRE_FILTER = {
  minVolume24hUsd: 10_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 500_000_000,
  maxAgeHours:     999_999,
}

const CHEAP_FILTER = {
  minMcUsd:        50_000,
  maxMcUsd:     500_000_000,
  minVol24h:        10_000,
  minLiqUsd:        20_000,
  minFeeTvl24hPct:       3,
  maxAgeHours:     999_999,
}

const MAX_DEEP_CHECKS = parseInt(process.env.MAX_DEEP_CHECKS ?? '20')
const DEEP_CHECK_DELAY_MS = parseInt(process.env.DEEP_CHECK_DELAY_MS ?? '3000')
const POOL_MIN_TVL_USD      = 20_000
const BIN_STEP_SCORE: Record<number, number> = { 50: 4, 100: 3, 200: 2, 300: 1 }

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '60')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')
const MAX_SOL_PER_POSITION     = parseFloat(process.env.MAX_SOL_PER_POSITION   ?? '0.05')
const SCAN_INTERVAL_MS         = parseInt(process.env.LP_SCAN_INTERVAL_SEC     ?? '900') * 1_000
const CANDIDATE_DEDUP_HOURS    = parseInt(process.env.CANDIDATE_DEDUP_HOURS    ?? '6')
const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const QUOTE_ASSETS = new Set([WSOL, USDC, USDT])
const SUPABASE_TIMEOUT_MS = 10_000
const METEORA_FETCH_TIMEOUT_MS = 45_000
const USE_HELIUS = process.env.HELIUS_ENABLED === 'true'

const _bondingCurveCache = new Map<string, { pct: number; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

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
    if (t.mcUsd < f.minMcUsd) fails.push(`mc=$${t.mcUsd.toFixed(0)}<$${f.minMcUsd}`)
    if (t.mcUsd > f.maxMcUsd) fails.push(`mc too high`)
    if (t.volume24h < f.minVolume24h) fails.push(`vol=$${t.volume24h.toFixed(0)}<$${f.minVolume24h}`)
    if (t.liquidityUsd < f.minLiquidityUsd) fails.push(`liq=$${t.liquidityUsd.toFixed(0)}<$${f.minLiquidityUsd}`)
    if (t.topHolderPct > f.maxTopHolderPct) fails.push(`topHolder=${t.topHolderPct.toFixed(1)}%>${f.maxTopHolderPct}%`)
    if (t.holderCount < f.minHolderCount) fails.push(`holders=${t.holderCount}<${f.minHolderCount}`)
    if (t.ageHours > f.maxAgeHours) fails.push(`age=${t.ageHours.toFixed(1)}h>${f.maxAgeHours}h`)
    if (t.rugcheckScore < f.minRugcheckScore) fails.push(`rug=${t.rugcheckScore}<${f.minRugcheckScore}`)
    if (t.feeTvl24hPct < f.minFeeTvl24hPct) fails.push(`feeTvl=${t.feeTvl24hPct.toFixed(2)}%<${f.minFeeTvl24hPct}%`)
    return fails.length === 0 ? null : `[${s.id}: ${fails.join(', ')}]`
  }).filter(Boolean)
  return perStrat.join(' | ') || 'all strategies disabled'
}

function selectBestPool(allPools: MeteoraPool[], mintAddress: string): MeteoraPool | null {
  const candidates = allPools.filter(p => {
    if (p.is_blacklisted) return false
    if (p.tvl < POOL_MIN_TVL_USD) return false
    const hasMint = p.token_x.address === mintAddress || p.token_y.address === mintAddress
    if (!hasMint) return false
    const hasQuote = QUOTE_ASSETS.has(p.token_x.address) || QUOTE_ASSETS.has(p.token_y.address)
    if (!hasQuote) return false
    return true
  })

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const maxFeeTvl = Math.max(...candidates.map(p => p.fee_tvl_ratio['24h']))
  let best: MeteoraPool | null = null
  let bestScore = -Infinity

  for (const p of candidates) {
    const feeTvlNorm = maxFeeTvl > 0 ? (p.fee_tvl_ratio['24h'] / maxFeeTvl) * 10 : 0
    const binStep = p.pool_config?.bin_step ?? 999
    const binStepBonus = BIN_STEP_SCORE[binStep] ?? 0
    const score = feeTvlNorm + binStepBonus
    if (score > bestScore) { bestScore = score; best = p }
  }

  return best
}

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

  console.log('[scanner] step 2/4 — cheap pre-screen')
  const mintBestMap = new Map<string, { pool: MeteoraPool; mcUsd: number; ageHours: number }>()

  for (const pool of pools) {
    const token = QUOTE_ASSETS.has(pool.token_x.address) ? pool.token_y : pool.token_x
    const vol24h = pool.volume['24h']
    const liqUsd = pool.tvl
    const mcUsd = token.market_cap ?? 0
    const feeTvl24h = pool.fee_tvl_ratio['24h'] * 100
    const ageHours = pool.created_at
      ? (Date.now() / 1000 - toUnixSeconds(pool.created_at)) / 3600
      : 0

    if (mcUsd < CHEAP_FILTER.minMcUsd) continue
    if (mcUsd > CHEAP_FILTER.maxMcUsd) continue
    if (vol24h < CHEAP_FILTER.minVol24h) continue
    if (liqUsd < CHEAP_FILTER.minLiqUsd) continue
    if (feeTvl24h < CHEAP_FILTER.minFeeTvl24hPct) continue

    const existing = mintBestMap.get(token.address)
    if (!existing || vol24h > existing.pool.volume['24h']) {
      mintBestMap.set(token.address, { pool, mcUsd, ageHours })
    }
  }

  const allSurvivors = Array.from(mintBestMap.values())
  console.log(`[scanner] step 2/4 — ${allSurvivors.length} unique tokens passed cheap filter (from ${pools.length} pools)`)

  if (allSurvivors.length === 0) {
    console.log('[scanner] done — no survivors')
    return { scanned: pools.length, candidates: 0, opened: 0 }
  }

  const survivors = allSurvivors
    .sort((a, b) => (b.pool.fee_tvl_ratio['24h'] ?? 0) - (a.pool.fee_tvl_ratio['24h'] ?? 0))
    .slice(0, MAX_DEEP_CHECKS)

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

  console.log(`[scanner] step 4/4 — deep checks on ${survivors.length} top survivors (capped from ${allSurvivors.length})`)
  let candidateCount = 0
  let openedCount = 0
  const heliusRpcUrl = process.env.HELIUS_RPC_URL ?? ''

  for (const { pool: representativePool, mcUsd, ageHours } of survivors) {
    await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS))

    const token = QUOTE_ASSETS.has(representativePool.token_x.address) ? representativePool.token_y : representativePool.token_x
    const tokenAddress = token.address
    const symbol = representativePool.name ?? token.symbol

    const recentResult = await withTimeout(
      supabase.from('candidates').select('id').eq('token_address', tokenAddress)
        .gte('scanned_at', new Date(Date.now() - CANDIDATE_DEDUP_HOURS * 60 * 60 * 1000).toISOString()).limit(1),
      SUPABASE_TIMEOUT_MS, `candidates dedup ${symbol}`
    )
    if (recentResult?.data && recentResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: scanned in last ${CANDIDATE_DEDUP_HOURS}h`); continue }

    const posResult = await withTimeout(
      supabase.from('lp_positions').select('id').eq('mint', tokenAddress)
        .in('status', ['active', 'out_of_range']).limit(1),
      SUPABASE_TIMEOUT_MS, `lp_positions dedup ${symbol}`
    )
    if (posResult?.data && posResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: open LP position exists`); continue }

    const bestPool = selectBestPool(pools, tokenAddress)
    if (!bestPool) {
      console.log(`[scanner] ${symbol} — skip: no qualifying pool found after best-pool selection`)
      continue
    }

    const vol24h = bestPool.volume['24h']
    const vol1h = bestPool.volume['1h']
    const liqUsd = bestPool.tvl
    const feeTvl24hPct = bestPool.fee_tvl_ratio['24h'] * 100
    const binStep = bestPool.pool_config?.bin_step ?? '?'

    if (bestPool.address !== representativePool.address) {
      console.log(`[scanner] ${symbol} — best pool upgraded: bin_step=${binStep}, feeTvl=${feeTvl24hPct.toFixed(2)}%, tvl=$${liqUsd.toFixed(0)} (was bin_step=${representativePool.pool_config?.bin_step}, feeTvl=${(representativePool.fee_tvl_ratio['24h'] * 100).toFixed(2)}%)`)
    }

    let resolvedMc = mcUsd
    if (!resolvedMc || resolvedMc < 1) {
      resolvedMc = await fetchMcFromDexScreener(tokenAddress, token.price)
      if (!resolvedMc || resolvedMc < 1) { console.log(`[scanner] ${symbol} — skip: no market_cap`); continue }
    }

    let holderCount = 0
    let topHolderPct = 0

    if (USE_HELIUS) {
      console.log(`[scanner] ${symbol} — calling Helius`)
      const holderData = await checkHolders(tokenAddress)
      holderCount = holderData.holderCount
      topHolderPct = holderData.topHolderPct
      if (!holderData.reliable && token.holders) {
        holderCount = Math.max(holderCount, token.holders)
      }
    } else {
      holderCount = token.holders ?? 0
      topHolderPct = 0
      console.log(`[scanner] ${symbol} — using Meteora holders (Helius disabled)`)
    }

    console.log(`[scanner] ${symbol} — calling Rugcheck`)
    const rugScore = await checkRugscore(tokenAddress)

    const holderCountForFilter = holderCount > 0 ? holderCount : (token.holders ?? 0)

    let bondingCurvePct: number | undefined = undefined
    if (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48) {
      const cached = _bondingCurveCache.get(tokenAddress)
      if (cached && Date.now() - cached.ts < BONDING_CACHE_TTL_MS) {
        bondingCurvePct = cached.pct
        console.log(`[pumpfun] ${symbol} bonding curve (cached): ${bondingCurvePct.toFixed(1)}%`)
      } else {
        const curve = await fetchBondingCurve(tokenAddress, heliusRpcUrl)
        bondingCurvePct = curve?.progressPct ?? undefined
        if (bondingCurvePct !== undefined) {
          _bondingCurveCache.set(tokenAddress, { pct: bondingCurvePct, ts: Date.now() })
          console.log(`[pumpfun] ${symbol} bonding curve: ${bondingCurvePct.toFixed(1)}% (complete=${curve?.complete})`)
        }
      }
    }

    const metrics: TokenMetrics = {
      address: tokenAddress,
      symbol,
      mcUsd: resolvedMc,
      volume24h: vol24h,
      liquidityUsd: liqUsd,
      topHolderPct,
      holderCount: holderCountForFilter,
      ageHours,
      rugcheckScore: rugScore,
      priceUsd: token.price,
      poolAddress: bestPool.address,
      dexId: 'meteora',
      feeTvl24hPct,
      bondingCurvePct,
    }

    const tokenClass = classifyToken({
      address: metrics.address,
      mcUsd: metrics.mcUsd,
      volume24h: metrics.volume24h,
      volume1h: vol1h,
      liquidityUsd: metrics.liquidityUsd,
      ageHours: metrics.ageHours,
      topHolderPct: metrics.topHolderPct,
      holderCount: metrics.holderCount,
      rugcheckScore: metrics.rugcheckScore,
    })

    const strategy = getStrategyForToken({ ...metrics, volume1h: vol1h })
    if (!strategy) {
      console.log(`[scanner] ${symbol} — no strategy (class=${tokenClass}): ${explainNoStrategy(metrics)}`)
      continue
    }

    const score = scoreCandidate(metrics, strategy)
    const bondingInfo = bondingCurvePct !== undefined ? `, curve=${bondingCurvePct.toFixed(1)}%` : ''

    await withTimeout(
      supabase.from('candidates').insert({
        token_address: metrics.address,
        symbol: metrics.symbol,
        score,
        strategy_matched: strategy.id,
        strategy_id: strategy.id,
        token_class: tokenClass,
        mc_at_scan: metrics.mcUsd,
        volume_24h: metrics.volume24h,
        holder_count: metrics.holderCount,
        rugcheck_score: metrics.rugcheckScore,
        top_holder_pct: metrics.topHolderPct,
        scanned_at: new Date().toISOString(),
      }),
      SUPABASE_TIMEOUT_MS, `candidates insert ${symbol}`
    )

    candidateCount++
    console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (class=${tokenClass}, score=${score}, mc=$${resolvedMc.toFixed(0)}, vol=$${vol24h.toFixed(0)}, feeTvl=${feeTvl24hPct.toFixed(2)}%, holders=${holderCountForFilter}, rug=${rugScore}, age=${ageHours.toFixed(1)}h, binStep=${binStep}${bondingInfo})`)
    await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct })

    if (score >= MIN_SCORE_TO_OPEN) {
      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        await sendAlert({ type: 'position_opened', symbol, strategy: strategy.id, solDeposited: MAX_SOL_PER_POSITION, entryPrice: metrics.priceUsd, positionId })
      }
    }
  }

  console.log(`[scanner] done — scanned: ${pools.length}, survivors: ${allSurvivors.length}, deep-checked: ${survivors.length}, candidates: ${candidateCount}, opened: ${openedCount}`)
  return { scanned: pools.length, candidates: candidateCount, opened: openedCount }
}

async function fetchMcFromDexScreener(mint: string, fallbackPrice: number): Promise<number> {
  try {
    const res = await axios.get(`${DEXSCREENER}/${mint}`, { timeout: 6_000 })
    const pairs: Array<{ fdv?: number; marketCap?: number }> = res.data?.pairs ?? []
    if (pairs.length === 0) return 0
    return pairs[0].marketCap ?? pairs[0].fdv ?? 0
  } catch {
    return 0
  }
}

async function fetchMeteoraPoolsFromEndpoint(baseUrl: string): Promise<MeteoraPool[]> {
  const allPools: MeteoraPool[] = []
  for (let page = 1; page <= 3; page++) {
    try {
      const res = await axios.get<PoolsResponse>(`${baseUrl}/pools`, {
        params: { page, page_size: 1000, sort_by: 'volume_24h:desc' },
        timeout: METEORA_FETCH_TIMEOUT_MS,
      })
      const data = res.data?.data ?? []
      allPools.push(...data)
      if (data.length < 1000) break
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
      const status = (err as { response?: { status?: number } })?.response?.status
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
    const hasQuote = QUOTE_ASSETS.has(p.token_x.address) || QUOTE_ASSETS.has(p.token_y.address)
    if (!hasQuote) return false
    return true
  })

  console.log(`[scanner] ${allPools.length} pools fetched; ${pools.length} passed JS pre-filter`)
  return { pools }
}

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
