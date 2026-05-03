import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { STRATEGIES, getStrategyForToken, classifyToken, explainNoStrategy } from '@/strategies'
import { scoreCandidateWithBreakdown } from './scorer'
import { openPosition } from './executor'
import { sendAlert } from './alerter'
import { checkHolders } from '@/lib/helius'
import { getRugscore, getRugcheckCacheSize } from './rugcheck-cache'
import {
  fetchBondingCurve,
  fetchPumpFunBondingCurve,
  isPumpFunToken,
  isMoonshotToken,
} from '@/lib/pumpfun'
import type { TokenMetrics } from '@/lib/types'
// ── DAMM v2 Edge (additive imports — do not remove or reorder) ────────────────
import { evaluateDammLaunch } from '@/strategies/damm-launch'
import { createAndOpenDammLaunch, type DammLaunchParams } from './damm-launch-executor'
import { evaluateDammEdge } from '@/strategies/damm-edge'
import { openDammPosition } from './damm-executor'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { getHeliusRpcEndpoint } from '@/lib/solana'
// ─────────────────────────────────────────────────────────────────────────────

const METEORA_DATAPI  = 'https://dlmm.datapi.meteora.ag'
const METEORA_DLMM    = 'https://dlmm-api.meteora.ag'
const DEXSCREENER     = 'https://api.dexscreener.com/latest/dex/tokens'

const PRE_FILTER = {
  minVolume24hUsd: 10_000,
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 500_000_000,
  minFeeTvlRatio1h: 0.04,
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

const MAX_DEEP_CHECKS          = parseInt(process.env.MAX_DEEP_CHECKS          ?? '6')
const DEEP_CHECK_DELAY_MS      = parseInt(process.env.DEEP_CHECK_DELAY_MS      ?? '3000')
const POOL_MIN_TVL_USD         = 20_000
const BIN_STEP_SCORE: Record<number, number> = { 50: 4, 100: 3, 200: 2, 300: 1 }

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
const MAX_CONCURRENT_POSITIONS = parseInt(process.env.MAX_CONCURRENT_POSITIONS ?? '5')
const MAX_SOL_PER_POSITION     = parseFloat(process.env.MAX_SOL_PER_POSITION   ?? '0.05')
const SCAN_INTERVAL_MS         = parseInt(process.env.LP_SCAN_INTERVAL_SEC     ?? '900') * 1_000
const CANDIDATE_DEDUP_HOURS    = parseFloat(process.env.CANDIDATE_DEDUP_HOURS  ?? '0')
const OOR_RECHECK_HOURS        = parseInt(process.env.OOR_RECHECK_HOURS        ?? '24')
const HARD_MAX_TOKEN_AGE_MINUTES = parseInt(process.env.HARD_MAX_TOKEN_AGE_MINUTES ?? '120')

const METEORA_FILTERED_FETCH = {
  minTvlUsd: parseFloat(process.env.METEORA_MIN_TVL_USD ?? '8000'),
  minFeeTvlRatio1h: parseFloat(process.env.METEORA_MIN_FEE_TVL_RATIO_1H ?? '0.04'),
  minVolumeTvl1hRatio: parseFloat(process.env.METEORA_MIN_VOLUME_TVL_1H_RATIO ?? '0.20'),
  limit: parseInt(process.env.METEORA_POOL_FETCH_LIMIT ?? '800'),
}

// Strict 15-min gate for new Meteora listings (0.25h)
const METEORA_NEW_LISTING_AGE_H   = 0.25
const METEORA_NEW_LISTING_LIQ_USD = 25_000
const METEORA_NEW_LISTING_FEETVL  = 8   // %

const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const QUOTE_ASSETS = new Set([WSOL, USDC, USDT])

const SUPABASE_TIMEOUT_MS      = 10_000
const METEORA_FETCH_TIMEOUT_MS = 45_000
const USE_HELIUS               = process.env.HELIUS_ENABLED === 'true'

const _bondingCurveCache = new Map<string, { pct: number; ts: number }>()
const BONDING_CACHE_TTL_MS = 10 * 60 * 1_000

// Thresholds for high-curve detection (logged, falls through to normal scoring)
const PUMPFUN_HIGHCURVE_THRESHOLD  = 95

export type ScannerResult = {
  scanned: number
  survivors: number
  deepChecked: number
  candidates: number
  opened: number
  openSkipped: number
  openSlots: number
  maxOpen: number
  openCount?: number
  openBlockedReason?: string
  error?: string
}

function detectLaunchpadSource(tokenAddress: string): 'pumpfun' | 'moonshot' | 'meteora' {
  if (isPumpFunToken(tokenAddress)) return 'pumpfun'
  if (isMoonshotToken(tokenAddress)) return 'moonshot'
  return 'meteora'
}

interface MeteoraToken {
  address: string
  symbol: string
  decimals: number
  holders: number
  market_cap: number
  price: number
}

interface MeteoraPool {
  address: string
  name: string
  created_at?: number | string
  pool_created_at?: number | string
  tvl: number | string
  current_price: number
  volume?: { '24h'?: number | string; '1h'?: number | string; '5m'?: number | string }
  volume_24h?: number | string
  volume_1h?: number | string
  volume_5m?: number | string
  fees?: { '24h'?: number | string; '1h'?: number | string; '5m'?: number | string }
  fee_tvl_ratio?: { '24h'?: number | string; '1h'?: number | string; '5m'?: number | string }
  fee_tvl_ratio_24h?: number | string
  fee_tvl_ratio_1h?: number | string
  fee_tvl_ratio_5m?: number | string
  pool_config?: { bin_step?: number; base_fee_pct?: number }
  token_x: MeteoraToken
  token_y: MeteoraToken
  is_blacklisted: boolean
}

type UnknownRecord = Record<string, unknown>

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function getRecordValue(record: UnknownRecord | null, keys: string[]): unknown {
  if (!record) return undefined
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

function normalizeMeteoraToken(raw: unknown, fallbackAddress: unknown, fallbackSymbol?: unknown): MeteoraToken | null {
  const token = asRecord(raw)
  const address = asString(getRecordValue(token, ['address', 'mint', 'mint_address']) ?? fallbackAddress)
  if (!address) return null

  return {
    address,
    symbol: asString(getRecordValue(token, ['symbol', 'name']) ?? fallbackSymbol) ?? address.slice(0, 4),
    decimals: asNumber(getRecordValue(token, ['decimals']), 0),
    holders: asNumber(getRecordValue(token, ['holders', 'holder_count']), 0),
    market_cap: asNumber(getRecordValue(token, ['market_cap', 'marketCap', 'fdv']), 0),
    price: asNumber(getRecordValue(token, ['price', 'price_usd', 'priceUsd']), 0),
  }
}

function normalizeMeteoraPool(raw: unknown): MeteoraPool | null {
  const pool = asRecord(raw)
  if (!pool) return null

  const address = asString(getRecordValue(pool, ['address', 'pool_address', 'poolAddress']))
  const tokenX = normalizeMeteoraToken(
    getRecordValue(pool, ['token_x', 'tokenX']),
    getRecordValue(pool, ['mint_x', 'token_x_mint', 'tokenXMint']),
    getRecordValue(pool, ['token_x_symbol', 'tokenXSymbol']),
  )
  const tokenY = normalizeMeteoraToken(
    getRecordValue(pool, ['token_y', 'tokenY']),
    getRecordValue(pool, ['mint_y', 'token_y_mint', 'tokenYMint']),
    getRecordValue(pool, ['token_y_symbol', 'tokenYSymbol']),
  )
  if (!address || !tokenX || !tokenY) return null

  const volume = asRecord(pool.volume)
  const fees = asRecord(pool.fees)
  const feeTvlRatio = asRecord(pool.fee_tvl_ratio)
  const poolConfig = asRecord(pool.pool_config)
  const binStep = asNumber(getRecordValue(poolConfig, ['bin_step']) ?? pool.bin_step, Number.NaN)
  const baseFeePct = asNumber(getRecordValue(poolConfig, ['base_fee_pct']) ?? pool.base_fee_percentage, Number.NaN)

  return {
    address,
    name: asString(pool.name) ?? `${tokenX.symbol}-${tokenY.symbol}`,
    created_at: pool.created_at as number | string | undefined,
    pool_created_at: getRecordValue(pool, ['pool_created_at', 'createdAt']) as number | string | undefined,
    tvl: getRecordValue(pool, ['tvl', 'liquidity']) as number | string | undefined ?? 0,
    current_price: asNumber(getRecordValue(pool, ['current_price', 'price']), 0),
    volume: volume as MeteoraPool['volume'],
    volume_24h: getRecordValue(pool, ['volume_24h', 'volume24h', 'trade_volume_24h']) as number | string | undefined,
    volume_1h: getRecordValue(pool, ['volume_1h', 'volume1h', 'trade_volume_1h']) as number | string | undefined,
    volume_5m: getRecordValue(pool, ['volume_5m', 'volume5m', 'trade_volume_5m']) as number | string | undefined,
    fees: fees as MeteoraPool['fees'],
    fee_tvl_ratio: feeTvlRatio as MeteoraPool['fee_tvl_ratio'],
    fee_tvl_ratio_24h: getRecordValue(pool, ['fee_tvl_ratio_24h', 'feeTvlRatio24h']) as number | string | undefined,
    fee_tvl_ratio_1h: getRecordValue(pool, ['fee_tvl_ratio_1h', 'feeTvlRatio1h']) as number | string | undefined,
    fee_tvl_ratio_5m: getRecordValue(pool, ['fee_tvl_ratio_5m', 'feeTvlRatio5m']) as number | string | undefined,
    pool_config: {
      ...(Number.isFinite(binStep) && { bin_step: binStep }),
      ...(Number.isFinite(baseFeePct) && { base_fee_pct: baseFeePct }),
    },
    token_x: tokenX,
    token_y: tokenY,
    is_blacklisted: pool.is_blacklisted === true,
  }
}

function normalizeMeteoraPoolsResponse(data: unknown): MeteoraPool[] {
  const response = asRecord(data)
  const rawPools = Array.isArray(data) ? data : Array.isArray(response?.data) ? response.data : []
  return rawPools.map(normalizeMeteoraPool).filter((pool): pool is MeteoraPool => Boolean(pool))
}

function toUnixSeconds(ts: number | string): number {
  const numeric = asNumber(ts, 0)
  return numeric > 1e10 ? numeric / 1000 : numeric
}

function getPoolCreatedAt(pool: MeteoraPool): number | null {
  const createdAt = pool.pool_created_at ?? pool.created_at
  if (!createdAt) return null
  const unixSeconds = toUnixSeconds(createdAt)
  return unixSeconds > 0 ? unixSeconds : null
}

function getPoolAgeMinutes(pool: MeteoraPool): number {
  const createdAt = getPoolCreatedAt(pool)
  if (!createdAt) return 999_999
  return Math.max(0, (Date.now() / 1000 - createdAt) / 60)
}

function getPoolVolume(pool: MeteoraPool, window: '24h' | '1h' | '5m'): number {
  const flatKey = `volume_${window}` as keyof MeteoraPool
  return asNumber(pool.volume?.[window] ?? pool[flatKey], 0)
}

function getPoolTvl(pool: MeteoraPool): number {
  return asNumber(pool.tvl, 0)
}

function getFeeTvlRatio(pool: MeteoraPool, window: '24h' | '1h' | '5m'): number {
  const flatKey = `fee_tvl_ratio_${window}` as keyof MeteoraPool
  return asNumber(pool.fee_tvl_ratio?.[window] ?? pool[flatKey], 0)
}

function getFeeTvlPct(pool: MeteoraPool, window: '24h' | '1h' | '5m'): number {
  return getFeeTvlRatio(pool, window) * 100
}

function getVolumeTvlRatio(pool: MeteoraPool, window: '1h' | '5m'): number {
  const tvl = getPoolTvl(pool)
  return tvl > 0 ? getPoolVolume(pool, window) / tvl : 0
}

function getRecentVolumeGrowth(pool: MeteoraPool): number {
  const vol5mAnnualizedTo1h = getPoolVolume(pool, '5m') * 12
  const vol1h = getPoolVolume(pool, '1h')
  if (vol1h <= 0) return vol5mAnnualizedTo1h > 0 ? 3 : 0
  return vol5mAnnualizedTo1h / vol1h
}

function scoreMeteoraMomentum(pool: MeteoraPool): number {
  const ageMinutes = getPoolAgeMinutes(pool)
  const feeTvl1h = getFeeTvlRatio(pool, '1h')
  const feeTvl5m = getFeeTvlRatio(pool, '5m')
  const volumeTvl1h = getVolumeTvlRatio(pool, '1h')
  const volumeGrowth = getRecentVolumeGrowth(pool)

  const ageScore =
    ageMinutes <= 30 ? 35 :
    ageMinutes <= 60 ? 28 :
    ageMinutes <= 90 ? 18 :
    ageMinutes <= 120 ? 8 :
    0
  const feeScore = Math.min(35, feeTvl1h * 350 + feeTvl5m * 700)
  const volumeScore = Math.min(20, volumeTvl1h * 40)
  const growthScore =
    volumeGrowth >= 2.5 ? 10 :
    volumeGrowth >= 1.5 ? 7 :
    volumeGrowth >= 1 ? 4 :
    0

  return Math.round(ageScore + feeScore + volumeScore + growthScore)
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

async function logScannerTick(result: ScannerResult, durationMs: number, source = 'scanner'): Promise<void> {
  try {
    const insertResult = await withTimeout(
      createServerClient().from('bot_logs').insert({
        level: result.error ? 'error' : 'info',
        event: result.error ? 'scanner_tick_failed' : 'scanner_tick',
        payload: { ...result, durationMs, source },
      }),
      SUPABASE_TIMEOUT_MS,
      'bot_logs insert scanner_tick',
    )
    if (insertResult && 'error' in insertResult && insertResult.error) {
      console.warn('[scanner] bot_logs insert failed:', insertResult.error.message)
    }
  } catch (err) {
    console.warn('[scanner] bot_logs insert failed:', err)
  }
}

function getQuoteTokenMint(pool: MeteoraPool): string {
  return QUOTE_ASSETS.has(pool.token_x.address)
    ? pool.token_x.address
    : pool.token_y.address
}

function selectBestPool(allPools: MeteoraPool[], mintAddress: string): MeteoraPool | null {
  const candidates = allPools.filter(p => {
    if (p.is_blacklisted) return false
    if (getPoolTvl(p) < POOL_MIN_TVL_USD) return false
    const hasMint = p.token_x.address === mintAddress || p.token_y.address === mintAddress
    if (!hasMint) return false
    const hasQuote = QUOTE_ASSETS.has(p.token_x.address) || QUOTE_ASSETS.has(p.token_y.address)
    if (!hasQuote) return false
    return true
  })

  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  const maxFeeTvl = Math.max(...candidates.map(p => getFeeTvlRatio(p, '24h')))
  let best: MeteoraPool | null = null
  let bestScore = -Infinity

  for (const p of candidates) {
    const feeTvlNorm = maxFeeTvl > 0 ? (getFeeTvlRatio(p, '24h') / maxFeeTvl) * 10 : 0
    const binStep = p.pool_config?.bin_step ?? 999
    const binStepBonus = BIN_STEP_SCORE[binStep] ?? 0
    const score = feeTvlNorm + binStepBonus + scoreMeteoraMomentum(p)
    if (score > bestScore) { bestScore = score; best = p }
  }

  return best
}

function survivorTokenAddress(item: { pool: MeteoraPool }): string {
  const token = QUOTE_ASSETS.has(item.pool.token_x.address) ? item.pool.token_y : item.pool.token_x
  return token.address
}

function findLiveOpenPosition(
  limitState: OpenLpLimitState | null,
  tokenAddress: string,
  poolAddress?: string,
) {
  return limitState?.livePositions.find(position =>
    position.mint === tokenAddress ||
    (!!poolAddress && position.pool_address === poolAddress),
  ) ?? null
}

async function fetchRecentlyClosedOorMints(supabase: ReturnType<typeof createServerClient>): Promise<Set<string>> {
  if (OOR_RECHECK_HOURS <= 0) return new Set()

  const result = await withTimeout(
    supabase
      .from('lp_positions')
      .select('mint, symbol, closed_at, close_reason')
      .eq('status', 'closed')
      .gte('closed_at', new Date(Date.now() - OOR_RECHECK_HOURS * 3_600_000).toISOString())
      .order('closed_at', { ascending: false })
      .limit(50),
    SUPABASE_TIMEOUT_MS,
    'recent OOR recheck rows',
  )

  if (!result || ('error' in result && result.error)) {
    const message = result && 'error' in result ? result.error?.message : 'timeout'
    console.warn(`[scanner] recent OOR recheck lookup failed: ${message}`)
    return new Set()
  }

  const rows = 'data' in result ? (result.data ?? []) : []
  return new Set(
    rows
      .filter((row: { mint?: string | null; close_reason?: string | null }) =>
        Boolean(row.mint) && String(row.close_reason ?? '').startsWith('out_of_range_'),
      )
      .map((row: { mint: string }) => row.mint),
  )
}

export async function runScanner(): Promise<ScannerResult> {
  const startedAt = Date.now()
  const finish = async (result: Partial<ScannerResult>): Promise<ScannerResult> => {
    const fullResult: ScannerResult = {
      scanned: 0,
      survivors: 0,
      deepChecked: 0,
      candidates: 0,
      opened: 0,
      openSkipped: 0,
      openSlots: 0,
      maxOpen: MAX_CONCURRENT_POSITIONS,
      ...result,
    }
    await logScannerTick(fullResult, Date.now() - startedAt)
    return fullResult
  }

  const state = await getBotState()
  if (!state.enabled) {
    console.log('[scanner] bot is stopped — skipping tick')
    return finish({ openBlockedReason: 'bot_stopped' })
  }

  console.log('[scanner] step 1/4 — fetching Meteora pools')
  const { pools, error: fetchError } = await fetchMeteoraPools()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return finish({ error: fetchError, openBlockedReason: 'pool_fetch_failed' })
  }
  console.log(`[scanner] step 1/4 — got ${pools.length} pools`)

  const freshPools = pools.filter(pool => getPoolAgeMinutes(pool) <= HARD_MAX_TOKEN_AGE_MINUTES)
  console.log(
    `[scanner] early age gate: ${freshPools.length}/${pools.length} pools <= ` +
    `${HARD_MAX_TOKEN_AGE_MINUTES}min`,
  )

  if (freshPools.length === 0) {
    console.log('[scanner] no fresh Meteora pools - skipping cheap/deep checks')
    return finish({ scanned: pools.length, survivors: 0, deepChecked: 0 })
  }

  console.log('[scanner] step 2/4 — cheap pre-screen')
  const mintBestMap = new Map<string, { pool: MeteoraPool; mcUsd: number; ageHours: number; momentumScore: number }>()
  let staleRejected = 0

  for (const pool of freshPools) {
    const token = QUOTE_ASSETS.has(pool.token_x.address) ? pool.token_y : pool.token_x
    const vol24h = getPoolVolume(pool, '24h')
    const liqUsd = getPoolTvl(pool)
    const mcUsd = token.market_cap ?? 0
    const feeTvl24h = getFeeTvlPct(pool, '24h')
    const feeTvl1h = getFeeTvlRatio(pool, '1h')
    const volumeTvl1h = getVolumeTvlRatio(pool, '1h')
    const ageHours = getPoolAgeMinutes(pool) / 60
    const ageMinutes = Number.isFinite(ageHours) ? ageHours * 60 : 999

    if (ageMinutes > HARD_MAX_TOKEN_AGE_MINUTES) {
      staleRejected++
      console.log(`[scanner] REJECT - ${pool.name ?? token.symbol} is ${ageMinutes.toFixed(1)}min old (max ${HARD_MAX_TOKEN_AGE_MINUTES}min)`)
      continue
    }

    if (mcUsd < CHEAP_FILTER.minMcUsd) continue
    if (mcUsd > CHEAP_FILTER.maxMcUsd) continue
    if (vol24h < CHEAP_FILTER.minVol24h) continue
    if (liqUsd < CHEAP_FILTER.minLiqUsd) continue
    if (feeTvl24h < CHEAP_FILTER.minFeeTvl24hPct) continue
    if (feeTvl1h < PRE_FILTER.minFeeTvlRatio1h && volumeTvl1h < METEORA_FILTERED_FETCH.minVolumeTvl1hRatio) continue

    const momentumScore = scoreMeteoraMomentum(pool)
    const existing = mintBestMap.get(token.address)
    if (!existing || momentumScore > existing.momentumScore) {
      mintBestMap.set(token.address, { pool, mcUsd, ageHours, momentumScore })
    }
  }

  const allSurvivors = Array.from(mintBestMap.values())
  console.log(
    `[scanner] step 2/4 — ${allSurvivors.length} unique fresh tokens passed cheap filter ` +
    `(from ${freshPools.length} fresh pools; stale rejected=${staleRejected})`,
  )

  if (allSurvivors.length === 0) {
    console.log('[scanner] done — no survivors')
    return finish({ scanned: pools.length, survivors: 0 })
  }

  const supabase = createServerClient()
  const recentlyClosedOorMints = await fetchRecentlyClosedOorMints(supabase)
  const prioritySurvivors = allSurvivors.filter(item => recentlyClosedOorMints.has(survivorTokenAddress(item)))
  const priorityMintSet = new Set(prioritySurvivors.map(survivorTokenAddress))
  const rankedSurvivors = allSurvivors
    .filter(item => !priorityMintSet.has(survivorTokenAddress(item)))
    .sort((a, b) => b.momentumScore - a.momentumScore)
  const survivors = [
    ...prioritySurvivors,
    ...rankedSurvivors.slice(0, Math.max(0, MAX_DEEP_CHECKS - prioritySurvivors.length)),
  ]

  if (recentlyClosedOorMints.size > 0) {
    const missed = Array.from(recentlyClosedOorMints).filter(mint => !priorityMintSet.has(mint))
    console.log(
      `[scanner] OOR recheck priority — ${prioritySurvivors.length} token(s) queued` +
      `${missed.length ? `, ${missed.length} did not pass cheap filter` : ''}`,
    )
  }

  console.log('[scanner] step 3/4 — live Meteora exposure + DB fallback check')

  const limitState = await withTimeout(
    getOpenLpLimitState(),
    METEORA_FETCH_TIMEOUT_MS,
    'live Meteora position limit state',
  )
  let openCount: number | undefined
  let availableOpenSlots = 0
  let openBlockedReason: string | undefined

  if (!limitState) {
    openBlockedReason = 'position_limit_unavailable'
    console.warn('[scanner] position limit check unavailable — scoring candidates but refusing to open new positions')
  } else {
    openCount = limitState.effectiveOpenCount
    if (!limitState.liveFetchOk) {
      console.warn(
        `[scanner] live position count incomplete (dlmmOk=${limitState.dlmmOk}, dammOk=${limitState.dammOk}) — ` +
        `using Supabase cache fallback for open caps`,
      )
    }
    availableOpenSlots = Math.max(0, MAX_CONCURRENT_POSITIONS - openCount)
    if (availableOpenSlots === 0) {
      openBlockedReason = 'max_positions_reached'
      console.log(
        `[scanner] max LP positions reached (${openCount}/${MAX_CONCURRENT_POSITIONS}; ` +
        `source=${limitState.countSource}, live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount}) — scoring candidates only`,
      )
    }
  }

  console.log(
    `[scanner] step 4/4 — deep checks on ${survivors.length} top momentum survivors ` +
    `(capped from ${allSurvivors.length}; MAX_DEEP_CHECKS=${MAX_DEEP_CHECKS})`,
  )
  let candidateCount = 0
  let openedCount = 0
  let openSkippedCount = 0
  const heliusRpcUrl = getHeliusRpcEndpoint() ?? ''

  for (const { pool: representativePool, mcUsd, ageHours } of survivors) {
    await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS))

    const token = QUOTE_ASSETS.has(representativePool.token_x.address) ? representativePool.token_y : representativePool.token_x
    const tokenAddress = token.address
    const symbol = representativePool.name ?? token.symbol
    const launchpadSource = detectLaunchpadSource(tokenAddress)
    const liveOpenPosition = findLiveOpenPosition(limitState, tokenAddress, representativePool.address)

    if (CANDIDATE_DEDUP_HOURS > 0) {
      const recentResult = await withTimeout(
        supabase.from('candidates').select('id').eq('token_address', tokenAddress)
          .gte('scanned_at', new Date(Date.now() - CANDIDATE_DEDUP_HOURS * 60 * 60 * 1000).toISOString()).limit(1),
        SUPABASE_TIMEOUT_MS, `candidates dedup ${symbol}`
      )
      if (recentResult?.data && recentResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: scanned in last ${CANDIDATE_DEDUP_HOURS}h`); continue }
    }

    if (liveOpenPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists (${liveOpenPosition.position_pubkey})`)
      continue
    }

    if (!limitState?.liveFetchOk) {
      const posResult = await withTimeout(
        supabase.from('lp_positions').select('id').eq('mint', tokenAddress)
          .in('status', OPEN_LP_STATUSES).limit(1),
        SUPABASE_TIMEOUT_MS, `lp_positions fallback dedup ${symbol}`
      )
      if (posResult?.data && posResult.data.length > 0) { console.log(`[scanner] ${symbol} — skip: cached open LP position exists (live fallback mode)`); continue }
    }

    // Pump.fun high-curve detection: log progress, then fall through to normal scoring.
    // The scorer awards +8 curveBonus at 70-95% and +4 at 95-99%.
    if (isPumpFunToken(tokenAddress) && heliusRpcUrl && ageHours < 48) {
      const curve = await fetchPumpFunBondingCurve(tokenAddress, heliusRpcUrl)
      const progress = curve?.progressPct ?? 0
      if (progress >= PUMPFUN_HIGHCURVE_THRESHOLD && curve?.complete === false) {
        console.log(`[scanner] ${symbol} — pump.fun high-curve ${progress.toFixed(1)}% — scoring normally (+curveBonus)`)
      } else {
        console.log(`[scanner] ${symbol} — pump.fun curve ${progress.toFixed(1)}% (complete=${curve?.complete ?? 'unknown'})`)
      }
      // Always fall through to normal pool selection and scoring
    }

    const bestPool = selectBestPool(freshPools, tokenAddress)
    if (!bestPool) {
      console.log(`[scanner] ${symbol} — skip: no qualifying pool found after best-pool selection`)
      continue
    }
    const liveBestPoolPosition = findLiveOpenPosition(limitState, tokenAddress, bestPool.address)
    if (liveBestPoolPosition) {
      console.log(`[scanner] ${symbol} — skip: live Meteora position already exists for best pool (${liveBestPoolPosition.position_pubkey})`)
      continue
    }

    const poolAgeHours  = getPoolAgeMinutes(bestPool) / 60
    const liqUsd        = getPoolTvl(bestPool)
    const feeTvl24hPct  = getFeeTvlPct(bestPool, '24h')
    const feeTvl1hPct   = getFeeTvlPct(bestPool, '1h')
    const feeTvl5mPct   = getFeeTvlPct(bestPool, '5m')
    const volumeTvl1hRatio = getVolumeTvlRatio(bestPool, '1h')
    const volumeGrowth1h = getRecentVolumeGrowth(bestPool)
    const momentumScore = scoreMeteoraMomentum(bestPool)

    // New Meteora listing fast-path: log and fall through to normal scoring.
    if (poolAgeHours < METEORA_NEW_LISTING_AGE_H && liqUsd >= METEORA_NEW_LISTING_LIQ_USD && feeTvl24hPct >= METEORA_NEW_LISTING_FEETVL) {
      console.log(
        `[scanner] ${symbol} — new Meteora listing ` +
        `(${(poolAgeHours * 60).toFixed(0)}min old, liq=$${liqUsd.toFixed(0)}, feeTvl=${feeTvl24hPct.toFixed(1)}%) — scoring normally`
      )
      // fall through to normal scoring + openPosition
    }

    const quoteTokenMint = getQuoteTokenMint(bestPool)

    const vol24h  = getPoolVolume(bestPool, '24h')
    const vol1h   = getPoolVolume(bestPool, '1h')
    const vol5m   = getPoolVolume(bestPool, '5m')
    const binStep: number | undefined = bestPool.pool_config?.bin_step
    const binStepDisplay = binStep ?? '?'

    if (bestPool.address !== representativePool.address) {
      console.log(`[scanner] ${symbol} — best pool upgraded: bin_step=${binStepDisplay}, feeTvl=${feeTvl24hPct.toFixed(2)}%, tvl=$${liqUsd.toFixed(0)}`)
    }

    let resolvedMc = mcUsd
    if (!resolvedMc || resolvedMc < 1) {
      resolvedMc = await fetchMcFromDexScreener(tokenAddress, token.price)
      if (!resolvedMc || resolvedMc < 1) { console.log(`[scanner] ${symbol} — skip: no market_cap`); continue }
    }

    let holderCount  = 0
    let topHolderPct = 0

    if (USE_HELIUS) {
      console.log(`[scanner] ${symbol} — calling Helius`)
      const holderData = await checkHolders(tokenAddress)
      holderCount  = holderData.holderCount
      topHolderPct = holderData.topHolderPct
      if (!holderData.reliable && token.holders) {
        holderCount = Math.max(holderCount, token.holders)
      }
    } else {
      holderCount  = token.holders ?? 0
      topHolderPct = 0
      console.log(`[scanner] ${symbol} — using Meteora holders (Helius disabled)`)
    }

    console.log(`[scanner] ${symbol} — calling Rugcheck`)
    const rugScore = await getRugscore(tokenAddress, symbol)

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
      address:        tokenAddress,
      symbol,
      mcUsd:          resolvedMc,
      volume24h:      vol24h,
      liquidityUsd:   liqUsd,
      topHolderPct,
      holderCount:    holderCountForFilter,
      ageHours,
      rugcheckScore:  rugScore,
      priceUsd:       token.price,
      poolAddress:    bestPool.address,
      dexId:          'meteora',
      feeTvl24hPct,
      feeTvl1hPct,
      feeTvl5mPct,
      volume1h:       vol1h,
      volume5m:       vol5m,
      volumeTvl1hRatio,
      volumeGrowth1h,
      momentumScore,
      bondingCurvePct,
      quoteTokenMint,
      binStep,
    }

    // ========== DAMM v2 LAUNCH (pool creation; isolated primary track) =========
    // This runs before damm-edge because the launch edge is pool creation, while
    // damm-edge only adds liquidity to an existing DAMM v2 pool.
    if (await evaluateDammLaunch(metrics)) {
      const dammLaunchParams: DammLaunchParams = {
        tokenAddress,
        poolAddress: bestPool.address,
        solAmount: MAX_SOL_PER_POSITION,
        symbol,
        ageMinutes: metrics.ageHours * 60,
        feeTvl24hPct: metrics.feeTvl24hPct,
        liquidityUsd: metrics.liquidityUsd,
        bondingCurvePct,
        tokenDecimals: token.decimals,
        priceUsd: metrics.priceUsd,
        initialPriceSol: bestPool.current_price,
        quoteTokenMint,
        feeTvl1hPct,
        feeTvl5mPct,
        volume1h: vol1h,
        volume5m: vol5m,
        momentumScore,
      }

      if (openBlockedReason || openedCount >= availableOpenSlots) {
        openSkippedCount++
        const reason = openBlockedReason ?? 'slots_filled_this_tick'
        console.log(`[scanner][damm-launch] ${symbol} qualifies but open skipped: ${reason}`)
        continue
      }

      console.log(`[scanner][damm-launch] TRIGGERED - creating DAMM v2 pool for ${symbol}`)
      const result = await createAndOpenDammLaunch(dammLaunchParams)
      if (result.success) {
        openedCount++
        await sendAlert({
          type:          'position_opened',
          symbol,
          strategy:      'damm-launch',
          solDeposited:  dammLaunchParams.solAmount,
          entryPrice:    metrics.priceUsd,
          poolAddress:   result.poolAddress,
          mint:          tokenAddress,
          positionId:    result.positionPubkey,
        })
        continue
      } else {
        console.error(`[scanner][damm-launch] createAndOpenDammLaunch failed for ${symbol}: ${result.error}`)
      }
    }
    // ========== END DAMM v2 LAUNCH ============================================

    // ========== DAMM v2 EDGE (additive hook — Meteora-origin pools only) =======
    // Fires ONLY for native Meteora pools (launchpadSource === 'meteora').
    // If the token qualifies, opens a DAMM v2 position and skips the DLMM path
    // for this token via `continue`. All existing DLMM strategy logic below is
    // untouched — this block is pure additive code.
    if (launchpadSource === 'meteora') {
      const dammDecision = await evaluateDammEdge(tokenAddress, metrics)
      console.log(`[scanner][damm-edge] ${symbol}: ${dammDecision.reason}`)
      if (dammDecision.shouldUseDamm && dammDecision.params) {
        if (openBlockedReason || openedCount >= availableOpenSlots) {
          openSkippedCount++
          const reason = openBlockedReason ?? 'slots_filled_this_tick'
          console.log(`[scanner][damm-edge] ${symbol} qualifies but open skipped: ${reason}`)
          continue
        }
        console.log(`[scanner][damm-edge] TRIGGERED — opening DAMM v2 position for ${symbol}`)
        const result = await openDammPosition(dammDecision.params)
        if (result.success) {
          openedCount++
          await sendAlert({
            type:          'position_opened',
            symbol,
            strategy:      'damm-edge',
            solDeposited:  dammDecision.params.solAmount,
            entryPrice:    metrics.priceUsd,
            positionId:    result.positionPubkey,
          })
        } else {
          console.error(`[scanner][damm-edge] openDammPosition failed for ${symbol}: ${result.error}`)
        }
        // Skip DLMM path for this token regardless of open success.
        // We do not want the same token evaluated by both tracks.
        continue
      }
    }
    // ========== END DAMM v2 EDGE ================================================

    const tokenClass = classifyToken({
      address:        metrics.address,
      mcUsd:          metrics.mcUsd,
      volume24h:      metrics.volume24h,
      volume1h:       vol1h,
      liquidityUsd:   metrics.liquidityUsd,
      ageHours:       metrics.ageHours,
      topHolderPct:   metrics.topHolderPct,
      holderCount:    metrics.holderCount,
      rugcheckScore:  metrics.rugcheckScore,
      quoteTokenMint: metrics.quoteTokenMint,
    })

    const strategy = getStrategyForToken({ ...metrics, volume1h: vol1h })
    if (!strategy) {
      const rejectionReason = explainNoStrategy(metrics)
      console.log(`[scanner] ${symbol} — no strategy (class=${tokenClass}, quote=${quoteTokenMint}): ${rejectionReason}`)
      console.log(JSON.stringify({
        event:     'candidate_evaluated',
        mint:      tokenAddress,
        symbol,
        score:     0,
        launchpad: launchpadSource,
        decision:  'REJECTED',
        reason:    rejectionReason,
      }))
      continue
    }

    const breakdown   = scoreCandidateWithBreakdown(metrics, strategy)
    const score       = breakdown.total
    const bondingInfo = bondingCurvePct !== undefined ? `, curve=${bondingCurvePct.toFixed(1)}%` : ''

    const accepted = score >= MIN_SCORE_TO_OPEN
    const rejectionReason = !accepted ? `score ${score} < threshold ${MIN_SCORE_TO_OPEN}` : null

    console.log(JSON.stringify({
      event:     'candidate_evaluated',
      mint:      tokenAddress,
      symbol,
      score,
      breakdown: {
        score_volmc:       breakdown.volMcScore,
        score_holders:     breakdown.holderScore,
        score_freshness:   breakdown.freshnessScore,
        score_fee_efficiency: breakdown.feeEfficiencyScore,
        score_volume_tvl:  breakdown.volumeTvlScore,
        score_curve_bonus: breakdown.curveBonus,
        final_score:       score,
      },
      launchpad: launchpadSource,
      decision:  accepted ? 'ACCEPTED' : 'REJECTED',
      reason:    rejectionReason,
    }))

    const insertResult = await withTimeout(
      supabase.from('candidates').insert({
        token_address:     metrics.address,
        symbol:            metrics.symbol,
        score,
        strategy_matched:  strategy.id,
        strategy_id:       strategy.id,
        token_class:       tokenClass,
        mc_at_scan:        metrics.mcUsd,
        volume_24h:        metrics.volume24h,
        holder_count:      metrics.holderCount,
        rugcheck_score:    metrics.rugcheckScore,
        top_holder_pct:    metrics.topHolderPct,
        scanned_at:        new Date().toISOString(),
        score_volmc:       breakdown.volMcScore,
        score_holders:     breakdown.holderScore,
        score_freshness:   breakdown.freshnessScore,
        score_curve_bonus: breakdown.curveBonus,
        launchpad_source:  launchpadSource,
      }),
      SUPABASE_TIMEOUT_MS, `candidates insert ${symbol}`
    )

    const insertOk = insertResult !== null && !('error' in insertResult && insertResult.error)
    if (!insertOk) {
      const errMsg = insertResult && 'error' in insertResult ? insertResult.error?.message : 'timeout'
      console.error(`[scanner] candidates insert failed for ${symbol} — skipping openPosition:`, errMsg)
      continue
    }

    candidateCount++
    console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (class=${tokenClass}, quote=${quoteTokenMint}, score=${score}, mc=$${resolvedMc.toFixed(0)}, vol=$${vol24h.toFixed(0)}, vol1h=$${vol1h.toFixed(0)}, feeTvl24h=${feeTvl24hPct.toFixed(2)}%, feeTvl1h=${feeTvl1hPct.toFixed(2)}%, volTvl1h=${volumeTvl1hRatio.toFixed(2)}, momentum=${momentumScore}, holders=${holderCountForFilter}, rug=${rugScore}, age=${ageHours.toFixed(1)}h, binStep=${binStepDisplay}${bondingInfo})`)
    await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct })

    if (score >= MIN_SCORE_TO_OPEN) {
      if (openBlockedReason || openedCount >= availableOpenSlots) {
        openSkippedCount++
        const reason = openBlockedReason ?? 'slots_filled_this_tick'
        console.log(`[scanner] ${symbol} qualifies but open skipped: ${reason}`)
        continue
      }

      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        await sendAlert({
          type: 'position_opened',
          symbol,
          strategy: strategy.id,
          solDeposited: MAX_SOL_PER_POSITION,
          entryPrice: metrics.priceUsd,
          entryPriceUsd: metrics.priceUsd,
          meteoracleScore: score,
          poolAddress: metrics.poolAddress,
          mint: metrics.address,
          positionId,
        })
      }
    }
  }

  if (USE_HELIUS) {
    const { getHolderCacheSize } = await import('@/lib/helius')
    console.log(`[scanner] Helius cache: ${getHolderCacheSize()} entries`)
  }
  console.log(`[scanner] Rugcheck cache: ${getRugcheckCacheSize()} entries`)

  console.log(
    `[scanner] done — scanned: ${pools.length}, survivors: ${allSurvivors.length}, ` +
    `deep-checked: ${survivors.length}, candidates: ${candidateCount}, opened: ${openedCount}, ` +
    `open-skipped: ${openSkippedCount}${openBlockedReason ? ` (${openBlockedReason})` : ''}`,
  )
  return finish({
    scanned: pools.length,
    survivors: allSurvivors.length,
    deepChecked: survivors.length,
    candidates: candidateCount,
    opened: openedCount,
    openSkipped: openSkippedCount,
    openSlots: availableOpenSlots,
    openCount,
    openBlockedReason,
  })
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
  const params = {
    page: 1,
    page_size: METEORA_FILTERED_FETCH.limit,
    limit: METEORA_FILTERED_FETCH.limit,
    sort: 'pool_created_at:desc',
    sort_by: 'pool_created_at:desc',
    'tvl>': METEORA_FILTERED_FETCH.minTvlUsd,
    'tvl[gte]': METEORA_FILTERED_FETCH.minTvlUsd,
    'fee_tvl_ratio_1h>': METEORA_FILTERED_FETCH.minFeeTvlRatio1h,
    'fee_tvl_ratio_1h[gte]': METEORA_FILTERED_FETCH.minFeeTvlRatio1h,
  }

  const res = await axios.get<unknown>(`${baseUrl}/pools`, {
    params,
    timeout: METEORA_FETCH_TIMEOUT_MS,
  })
  const pools = normalizeMeteoraPoolsResponse(res.data)
  if (pools.length > 0) return pools

  console.warn(`[scanner] ${baseUrl}/pools returned no usable pools; trying documented /pair/all fallback`)
  const fallback = await axios.get<unknown>(`${baseUrl}/pair/all`, {
    timeout: METEORA_FETCH_TIMEOUT_MS,
  })
  return normalizeMeteoraPoolsResponse(fallback.data)
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
    if (getPoolVolume(p, '24h') < PRE_FILTER.minVolume24hUsd) return false
    if (getPoolTvl(p) < PRE_FILTER.minLiquidityUsd) return false
    if (getPoolTvl(p) > PRE_FILTER.maxLiquidityUsd) return false
    const hasQuote = QUOTE_ASSETS.has(p.token_x.address) || QUOTE_ASSETS.has(p.token_y.address)
    if (!hasQuote) return false
    return true
  })

  console.log(
    `[scanner] ${allPools.length} filtered Meteora pools fetched; ${pools.length} passed JS pre-filter ` +
    `(minTvl=$${METEORA_FILTERED_FETCH.minTvlUsd}, minFeeTvl1h=${(METEORA_FILTERED_FETCH.minFeeTvlRatio1h * 100).toFixed(1)}%)`,
  )
  return { pools }
}

const standaloneScannerTick = async (): Promise<void> => {
  const label = '[lp-scanner]'
  try {
    const result = await runScanner()
    const blocked = result.openBlockedReason ? ` openBlocked=${result.openBlockedReason}` : ''
    console.log(
      `${label} tick done — scanned=${result.scanned} survivors=${result.survivors} ` +
      `deepChecked=${result.deepChecked} candidates=${result.candidates} opened=${result.opened} ` +
      `openSkipped=${result.openSkipped}${blocked}`,
    )
  } catch (err) {
    console.error(`${label} tick error:`, err)
    await logScannerTick({
      scanned: 0,
      survivors: 0,
      deepChecked: 0,
      candidates: 0,
      opened: 0,
      openSkipped: 0,
      openSlots: 0,
      maxOpen: MAX_CONCURRENT_POSITIONS,
      openBlockedReason: 'unhandled_error',
      error: err instanceof Error ? err.message : String(err),
    }, 0)
  }
}

if (require.main === module || process.env.LP_SCANNER_STANDALONE === 'true') {
  const label = '[lp-scanner]'
  console.log(`${label} starting — poll every ${SCAN_INTERVAL_MS / 1000}s`)
  standaloneScannerTick().then(() => setInterval(standaloneScannerTick, SCAN_INTERVAL_MS))
}
