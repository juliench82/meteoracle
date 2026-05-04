import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { getStrategyForToken, classifyToken, explainNoStrategy } from '@/strategies'
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
import { evaluateDammEdge } from '@/strategies/damm-edge'
import { EVIL_PANDA_SCANNER_SCORE_WEIGHTS } from '@/strategies/evil-panda'
import { scalpSpikeStrategy, SCALP_SPIKE_MOMENTUM_REGAIN } from '@/strategies/scalp-spike'
import { openDammPosition, resolveVerifiedDammV2PoolForToken } from './damm-executor'
import { OPEN_LP_STATUSES, getOpenLpLimitState, type OpenLpLimitState } from '@/lib/position-limits'
import { getHeliusRpcEndpoint } from '@/lib/solana'

const METEORA_DATAPI  = 'https://dlmm.datapi.meteora.ag'
const METEORA_DLMM    = 'https://dlmm-api.meteora.ag'
const DEXSCREENER     = 'https://api.dexscreener.com/latest/dex/tokens'

const PRE_FILTER = {
  minLiquidityUsd: 20_000,
  maxLiquidityUsd: 500_000_000,
}

const MAX_DEEP_CHECKS          = parseInt(process.env.MAX_DEEP_CHECKS          ?? '6')
const DEEP_CHECK_DELAY_MS      = parseInt(process.env.DEEP_CHECK_DELAY_MS      ?? '3000')
const POOL_MIN_TVL_USD         = 20_000
const BIN_STEP_SCORE: Record<number, number> = { 50: 4, 100: 3, 200: 2, 300: 1 }

const MIN_SCORE_TO_OPEN        = parseInt(process.env.MIN_SCORE_TO_OPEN        ?? '65')
const MAX_CONCURRENT_MARKET_LP_POSITIONS = parseInt(
  process.env.MAX_CONCURRENT_MARKET_LP_POSITIONS ?? process.env.MAX_CONCURRENT_POSITIONS ?? '5',
)
const MAX_CONCURRENT_DAMM_POSITIONS = parseInt(process.env.MAX_CONCURRENT_DAMM_POSITIONS ?? '2', 10)
const MARKET_LP_SOL_PER_POSITION = parseFloat(
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.05',
)
const SCALP_SPIKE_ENABLED = process.env.SCALP_SPIKE_ENABLED === 'true'
const EVIL_PANDA_ENABLED = process.env.EVIL_PANDA_ENABLED === 'true'
const DAMM_EDGE_ENABLED = process.env.DAMM_EDGE_ENABLED === 'true'
const SCAN_INTERVAL_MS         = parseInt(process.env.LP_SCAN_INTERVAL_SEC     ?? '900') * 1_000
const CANDIDATE_DEDUP_HOURS    = parseFloat(process.env.CANDIDATE_DEDUP_HOURS  ?? '0')
const OOR_RECHECK_HOURS        = parseInt(process.env.OOR_RECHECK_HOURS        ?? '24')
const HARD_MAX_TOKEN_AGE_MINUTES = parseInt(process.env.HARD_MAX_TOKEN_AGE_MINUTES ?? '120')
const SCANNER_EARLY_MAX_AGE_MINUTES = parseInt(process.env.SCANNER_EARLY_MAX_AGE_MINUTES ?? '90', 10)
const FRESH_MAX_AGE_MINUTES    = Math.min(
  parseInt(process.env.FRESH_SCANNER_MAX_AGE_MINUTES ?? `${HARD_MAX_TOKEN_AGE_MINUTES}`),
  SCANNER_EARLY_MAX_AGE_MINUTES,
)
const FRESH_MIN_LIQUIDITY_USD  = parseFloat(process.env.FRESH_MIN_LIQUIDITY_USD ?? process.env.EVIL_PANDA_MIN_LIQUIDITY_USD ?? '20000')
const MOMENTUM_MIN_VOLUME_5M_USD = parseFloat(process.env.MOMENTUM_MIN_VOLUME_5M_USD ?? '5000')
const MOMENTUM_POOL_LIMIT      = parseInt(process.env.MOMENTUM_POOL_LIMIT ?? '500')
const MOMENTUM_MIN_FEE_TVL_5M_PCT = parseFloat(process.env.MOMENTUM_MIN_FEE_TVL_5M_PCT ?? process.env.SCALP_SPIKE_MIN_FEE_TVL_5M_PCT ?? '0.1')
const SCALP_SPIKE_VOL_RATIO    = parseFloat(process.env.SCALP_SPIKE_VOL_RATIO ?? '2.5')
const MAX_FRESH_DEEP_CHECKS    = parseInt(process.env.MAX_FRESH_DEEP_CHECKS ?? `${MAX_DEEP_CHECKS}`)
const MAX_MOMENTUM_DEEP_CHECKS = parseInt(process.env.MAX_MOMENTUM_DEEP_CHECKS ?? `${MAX_DEEP_CHECKS}`)

const METEORA_FILTERED_FETCH = {
  minTvlUsd: parseFloat(process.env.METEORA_MIN_TVL_USD ?? '8000'),
  minFeeTvlRatio1h: parseFloat(process.env.METEORA_MIN_FEE_TVL_RATIO_1H ?? '0.001'),
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
type ScannerLane = 'fresh' | 'momentum'

type LaneSurvivor = {
  pool: MeteoraPool
  mcUsd: number
  ageHours: number
  momentumScore: number
  lane: ScannerLane
}

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
    ageMinutes <= 30 ? 20 :
    ageMinutes <= 60 ? 16 :
    ageMinutes <= 90 ? 10 :
    ageMinutes <= 120 ? 4 :
    0
  const feeScore = Math.min(45, feeTvl1h * 650 + feeTvl5m * 500)
  const volumeScore = Math.min(25, volumeTvl1h * 60)
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

function selectBestPool(allPools: MeteoraPool[], mintAddress: string, lane: ScannerLane = 'fresh'): MeteoraPool | null {
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

  const feeWindow = lane === 'momentum' ? '5m' : '24h'
  const maxFeeTvl = Math.max(...candidates.map(p => getFeeTvlRatio(p, feeWindow)))
  let best: MeteoraPool | null = null
  let bestScore = -Infinity

  for (const p of candidates) {
    const feeTvlNorm = maxFeeTvl > 0 ? (getFeeTvlRatio(p, feeWindow) / maxFeeTvl) * 10 : 0
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

function getTradableToken(pool: MeteoraPool): MeteoraToken {
  return QUOTE_ASSETS.has(pool.token_x.address) ? pool.token_y : pool.token_x
}

function getFiveMinuteVolumeSpike(pool: MeteoraPool): number {
  const volume5m = getPoolVolume(pool, '5m')
  const volume1h = getPoolVolume(pool, '1h')
  const oneHourPerFiveMinutes = volume1h / 12
  return oneHourPerFiveMinutes > 0 ? volume5m / oneHourPerFiveMinutes : 0
}

function getOneHourVolumeVs24hAverage(pool: MeteoraPool): number {
  const volume24hAvg = getPoolVolume(pool, '24h') / 24
  if (volume24hAvg <= 0) return getPoolVolume(pool, '1h') > 0 ? Number.POSITIVE_INFINITY : 0
  return getPoolVolume(pool, '1h') / volume24hAvg
}

function getOneHourFeeTvlVs24hAverage(pool: MeteoraPool): number {
  const feeTvl24hAvg = getFeeTvlPct(pool, '24h') / 24
  if (feeTvl24hAvg <= 0) return getFeeTvlPct(pool, '1h') > 0 ? Number.POSITIVE_INFINITY : 0
  return getFeeTvlPct(pool, '1h') / feeTvl24hAvg
}

function passesMomentumRegain(pool: MeteoraPool): boolean {
  const ageHours = getPoolAgeMinutes(pool) / 60
  if (
    ageHours < SCALP_SPIKE_MOMENTUM_REGAIN.minAgeHours ||
    ageHours > SCALP_SPIKE_MOMENTUM_REGAIN.maxAgeHours
  ) {
    return false
  }

  const volumeRegain =
    getPoolVolume(pool, '1h') >= SCALP_SPIKE_MOMENTUM_REGAIN.minVolume1hUsd &&
    getOneHourVolumeVs24hAverage(pool) >= SCALP_SPIKE_MOMENTUM_REGAIN.minVolume1hTo24hAvgRatio
  const feeRegain =
    getFeeTvlPct(pool, '1h') >= SCALP_SPIKE_MOMENTUM_REGAIN.minFeeTvl1hPct &&
    getOneHourFeeTvlVs24hAverage(pool) >= SCALP_SPIKE_MOMENTUM_REGAIN.minFeeTvl1hTo24hAvgRatio

  return volumeRegain || feeRegain
}

function passesMomentumSpike(pool: MeteoraPool): boolean {
  return (
    getPoolVolume(pool, '5m') >= MOMENTUM_MIN_VOLUME_5M_USD &&
    getFiveMinuteVolumeSpike(pool) >= SCALP_SPIKE_VOL_RATIO &&
    getFeeTvlPct(pool, '5m') >= MOMENTUM_MIN_FEE_TVL_5M_PCT
  )
}

function passesMomentumLane(pool: MeteoraPool): boolean {
  return passesMomentumSpike(pool) || passesMomentumRegain(pool)
}

function poolSortTimestamp(pool: MeteoraPool): number {
  return getPoolCreatedAt(pool) ?? 0
}

function pushBestSurvivor(
  map: Map<string, LaneSurvivor>,
  pool: MeteoraPool,
  lane: ScannerLane,
  momentumScore: number,
): void {
  const token = getTradableToken(pool)
  const existing = map.get(token.address)
  if (!existing || momentumScore > existing.momentumScore) {
    map.set(token.address, {
      pool,
      mcUsd: token.market_cap ?? 0,
      ageHours: getPoolAgeMinutes(pool) / 60,
      momentumScore,
      lane,
    })
  }
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

function getDisabledStrategyReason(strategyId: string): string | null {
  if (strategyId === 'scalp-spike' && !SCALP_SPIKE_ENABLED) return 'SCALP_SPIKE_ENABLED is not true'
  if (strategyId === 'evil-panda' && !EVIL_PANDA_ENABLED) return 'EVIL_PANDA_ENABLED is not true'
  return null
}

function getOpenDammEdgeCount(limitState: OpenLpLimitState | null): number {
  return limitState?.livePositions.filter(position =>
    position.position_type === 'damm-edge' || position.strategy_id === 'damm-edge',
  ).length ?? 0
}

function scoreFeeTvl1hPct(pct: number): number {
  if (pct >= 8) return 100
  if (pct >= 5) return 85
  if (pct >= 3) return 65
  if (pct >= 1.5) return 40
  if (pct >= 0.5) return 20
  return 0
}

function scoreVolumeTvl1hRatio(ratio: number): number {
  if (ratio >= 1.5) return 100
  if (ratio >= 1.0) return 90
  if (ratio >= 0.5) return 75
  if (ratio >= 0.2) return 55
  if (ratio >= 0.1) return 30
  return 0
}

function scoreHolderCount(holderCount: number): number {
  if (holderCount >= 5000) return 100
  if (holderCount >= 2000) return 80
  if (holderCount >= 1000) return 65
  if (holderCount >= 500) return 45
  if (holderCount >= 200) return 25
  return 10
}

function getMomentumRegainBreakdown(
  metrics: TokenMetrics,
): ReturnType<typeof scoreCandidateWithBreakdown> {
  const rugScore = Math.max(0, Math.min(100, metrics.rugcheckScore))
  const holderScore = scoreHolderCount(metrics.holderCount)
  const feeEfficiencyScore = scoreFeeTvl1hPct(metrics.feeTvl1hPct ?? 0)
  const volumeTvlScore = scoreVolumeTvl1hRatio(metrics.volumeTvl1hRatio ?? 0)
  const freshnessScore =
    metrics.ageHours <= 6 ? 100 :
    metrics.ageHours <= 12 ? 85 :
    metrics.ageHours <= 24 ? 70 :
    55
  const total = Math.round(
    Math.min(
      100,
      feeEfficiencyScore * 0.35 +
      volumeTvlScore * 0.35 +
      rugScore * 0.15 +
      holderScore * 0.10 +
      freshnessScore * 0.05,
    ),
  )

  return {
    total,
    volMcScore: 0,
    rugScore,
    holderScore,
    freshnessScore,
    feeEfficiencyScore,
    volumeTvlScore,
    curveBonus: 0,
  }
}

function getScannerAdjustedScore(
  metrics: TokenMetrics,
  strategyId: string,
  breakdown: ReturnType<typeof scoreCandidateWithBreakdown>,
): number {
  if (strategyId !== 'evil-panda') return breakdown.total

  const weights = EVIL_PANDA_SCANNER_SCORE_WEIGHTS
  const totalWeight =
    weights.freshness +
    weights.rugcheck +
    weights.holders +
    weights.feeTvl1h +
    weights.volumeTvl1h

  if (totalWeight <= 0) return breakdown.total

  const feeTvl1hScore = scoreFeeTvl1hPct(metrics.feeTvl1hPct ?? 0)
  const volumeTvl1hScore = scoreVolumeTvl1hRatio(metrics.volumeTvl1hRatio ?? 0)
  const weighted =
    (breakdown.freshnessScore * weights.freshness +
      breakdown.rugScore * weights.rugcheck +
      breakdown.holderScore * weights.holders +
      feeTvl1hScore * weights.feeTvl1h +
      volumeTvl1hScore * weights.volumeTvl1h) / totalWeight

  const total = Math.round(Math.min(100, Math.max(0, weighted + breakdown.curveBonus)))
  console.log(
    `[scanner] ${metrics.symbol} — evil-panda weighted score ` +
    `fee1h=${feeTvl1hScore} volTvl1h=${volumeTvl1hScore} raw=${breakdown.total} → ${total}`,
  )
  return total
}

function passesMomentumRegainStrategyFilters(metrics: TokenMetrics): boolean {
  const f = scalpSpikeStrategy.filters
  return (
    scalpSpikeStrategy.enabled &&
    metrics.mcUsd >= f.minMcUsd &&
    metrics.mcUsd <= f.maxMcUsd &&
    metrics.liquidityUsd >= f.minLiquidityUsd &&
    metrics.topHolderPct <= f.maxTopHolderPct &&
    metrics.holderCount >= f.minHolderCount &&
    metrics.ageHours <= f.maxAgeHours &&
    metrics.rugcheckScore >= f.minRugcheckScore &&
    metrics.feeTvl24hPct >= f.minFeeTvl24hPct
  )
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
      maxOpen: MAX_CONCURRENT_MARKET_LP_POSITIONS,
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
  const { pools: fetchedPools, error: fetchError } = await fetchMeteoraPools()
  if (fetchError) {
    console.error('[scanner] fetch failed:', fetchError)
    return finish({ error: fetchError, openBlockedReason: 'pool_fetch_failed' })
  }

  const earlyAgePools = fetchedPools.filter(pool => getPoolAgeMinutes(pool) <= SCANNER_EARLY_MAX_AGE_MINUTES)
  const momentumRegainPools = fetchedPools.filter(passesMomentumRegain)
  const pools = Array.from(
    new Map([...earlyAgePools, ...momentumRegainPools].map(pool => [pool.address, pool])).values(),
  )
  console.log(`[scanner] step 1/4 — got ${pools.length} pools`)
  console.log(
    `[scanner] early age gate — kept ${earlyAgePools.length}/${fetchedPools.length} ` +
    `<=${SCANNER_EARLY_MAX_AGE_MINUTES}min + ${momentumRegainPools.length} momentum-regain exception(s)`,
  )

  const freshPools = pools.filter(pool => getPoolAgeMinutes(pool) <= FRESH_MAX_AGE_MINUTES)
  const momentumPools = pools
    .filter(pool => !pool.is_blacklisted)
    .filter(passesMomentumLane)
    .sort((a, b) => scoreMeteoraMomentum(b) - scoreMeteoraMomentum(a))
    .slice(0, MOMENTUM_POOL_LIMIT)

  console.log(
    `[scanner] lanes — fresh=${freshPools.length}/${pools.length} <=${FRESH_MAX_AGE_MINUTES}min, ` +
    `momentum=${momentumPools.length}/${pools.length} spike/regain candidates`,
  )

  console.log('[scanner] step 2/4 — lane pre-screen')
  const freshBestMap = new Map<string, LaneSurvivor>()
  const momentumBestMap = new Map<string, LaneSurvivor>()
  let freshRejectedAge = 0
  let freshRejectedLiquidity = 0
  let momentumRejectedSpike = 0

  for (const pool of freshPools) {
    const token = getTradableToken(pool)
    const liqUsd = getPoolTvl(pool)
    const ageMinutes = getPoolAgeMinutes(pool)

    if (ageMinutes > FRESH_MAX_AGE_MINUTES) {
      freshRejectedAge++
      console.log(`[scanner] REJECT - ${pool.name ?? token.symbol} is ${ageMinutes.toFixed(1)}min old (max ${FRESH_MAX_AGE_MINUTES}min)`)
      continue
    }
    if (liqUsd < FRESH_MIN_LIQUIDITY_USD) {
      freshRejectedLiquidity++
      continue
    }

    pushBestSurvivor(freshBestMap, pool, 'fresh', scoreMeteoraMomentum(pool))
  }

  for (const pool of momentumPools) {
    const liqUsd = getPoolTvl(pool)
    if (liqUsd < 30_000) continue
    if (!passesMomentumLane(pool)) {
      momentumRejectedSpike++
      continue
    }
    pushBestSurvivor(momentumBestMap, pool, 'momentum', scoreMeteoraMomentum(pool))
  }

  const freshSurvivors = Array.from(freshBestMap.values()).sort((a, b) => b.momentumScore - a.momentumScore)
  const momentumSurvivors = Array.from(momentumBestMap.values()).sort((a, b) => {
    const volumeDiff = getPoolVolume(b.pool, '5m') - getPoolVolume(a.pool, '5m')
    return volumeDiff !== 0 ? volumeDiff : b.momentumScore - a.momentumScore
  })
  const allSurvivors = [...freshSurvivors, ...momentumSurvivors]

  console.log(
    `[scanner] step 2/4 — fresh survivors=${freshSurvivors.length} ` +
    `(ageRejected=${freshRejectedAge}, liquidityRejected=${freshRejectedLiquidity}); ` +
    `momentum survivors=${momentumSurvivors.length} (spikeRejected=${momentumRejectedSpike})`,
  )

  if (allSurvivors.length === 0) {
    console.log('[scanner] done — no lane survivors')
    return finish({ scanned: pools.length, survivors: 0 })
  }

  const supabase = createServerClient()
  const recentlyClosedOorMints = await fetchRecentlyClosedOorMints(supabase)
  const pickLaneSurvivors = (laneSurvivors: LaneSurvivor[], maxDeepChecks: number): LaneSurvivor[] => {
    const priority = laneSurvivors.filter(item => recentlyClosedOorMints.has(survivorTokenAddress(item)))
    const priorityMintSet = new Set(priority.map(survivorTokenAddress))
    const ranked = laneSurvivors.filter(item => !priorityMintSet.has(survivorTokenAddress(item)))
    return [
      ...priority,
      ...ranked.slice(0, Math.max(0, maxDeepChecks - priority.length)),
    ]
  }
  const survivors = [
    ...pickLaneSurvivors(freshSurvivors, MAX_FRESH_DEEP_CHECKS),
    ...pickLaneSurvivors(momentumSurvivors, MAX_MOMENTUM_DEEP_CHECKS),
  ]

  if (recentlyClosedOorMints.size > 0) {
    const queuedMints = new Set(survivors.map(survivorTokenAddress))
    const missed = Array.from(recentlyClosedOorMints).filter(mint => !queuedMints.has(mint))
    console.log(
      `[scanner] OOR recheck priority — ${recentlyClosedOorMints.size - missed.length} token(s) queued` +
      `${missed.length ? `, ${missed.length} did not pass lane filters` : ''}`,
    )
  }

  console.log('[scanner] step 3/4 — live Meteora exposure + DB fallback check')

  const limitState = await withTimeout(
    getOpenLpLimitState('market'),
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
    availableOpenSlots = Math.max(0, MAX_CONCURRENT_MARKET_LP_POSITIONS - openCount)
    if (availableOpenSlots === 0) {
      openBlockedReason = 'max_positions_reached'
      console.log(
        `[scanner] max market LP positions reached (${openCount}/${MAX_CONCURRENT_MARKET_LP_POSITIONS}; ` +
        `source=${limitState.countSource}, live=${limitState.liveOpenCount}, cached=${limitState.cachedOpenCount}) — scoring candidates only`,
      )
    }
  }

  console.log(
    `[scanner] step 4/4 — deep checks on ${survivors.length} lane survivors ` +
    `(fresh cap=${MAX_FRESH_DEEP_CHECKS}, momentum cap=${MAX_MOMENTUM_DEEP_CHECKS}, total queued from ${allSurvivors.length})`,
  )
  let candidateCount = 0
  let openedCount = 0
  let openedDammCountThisTick = 0
  let openSkippedCount = 0
  const heliusRpcUrl = getHeliusRpcEndpoint() ?? ''
  const openedMintsThisTick = new Set<string>()

  for (const { pool: representativePool, mcUsd, ageHours, lane } of survivors) {
    await new Promise(r => setTimeout(r, DEEP_CHECK_DELAY_MS))

    const token = getTradableToken(representativePool)
    const tokenAddress = token.address
    const symbol = representativePool.name ?? token.symbol
    const launchpadSource = detectLaunchpadSource(tokenAddress)
    const liveOpenPosition = findLiveOpenPosition(limitState, tokenAddress, representativePool.address)

    if (openedMintsThisTick.has(tokenAddress)) {
      console.log(`[scanner] ${symbol} — skip ${lane} lane: position already opened earlier this tick`)
      continue
    }

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

    const bestPool = selectBestPool(lane === 'fresh' ? freshPools : momentumPools, tokenAddress, lane)
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
    if (
      poolAgeHours < METEORA_NEW_LISTING_AGE_H &&
      liqUsd >= METEORA_NEW_LISTING_LIQ_USD &&
      Math.max(feeTvl1hPct, feeTvl5mPct * 12) >= METEORA_NEW_LISTING_FEETVL
    ) {
      console.log(
        `[scanner] ${symbol} — new Meteora listing ` +
        `(${(poolAgeHours * 60).toFixed(0)}min old, liq=$${liqUsd.toFixed(0)}, recentFeeTvl=${Math.max(feeTvl1hPct, feeTvl5mPct * 12).toFixed(1)}%) — scoring normally`
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
      if (!resolvedMc || resolvedMc < 1) {
        if (lane !== 'fresh') {
          console.log(`[scanner] ${symbol} — skip: no market_cap`)
          continue
        }
        resolvedMc = 0
        console.log(`[scanner] ${symbol} — no market_cap yet; fresh lane will rely on liquidity + Rugcheck`)
      }
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

    // ========== DAMM v2 EDGE (additive hook — Meteora-origin pools only) =======
    // Fires ONLY for native Meteora pools (launchpadSource === 'meteora').
    // If the token qualifies, resolves a verified DAMM v2 pool before opening.
    // The DLMM path is skipped only after a DAMM open actually succeeds.
    // All existing DLMM strategy logic below is
    // untouched — this block is pure additive code.
    if (lane === 'fresh' && launchpadSource === 'meteora') {
      const dammDecision = await evaluateDammEdge(tokenAddress, metrics)
      console.log(`[scanner][damm-edge] ${symbol}: ${dammDecision.reason}`)
      if (dammDecision.shouldUseDamm && dammDecision.params) {
        if (!DAMM_EDGE_ENABLED) {
          console.log(`[scanner][damm-edge] ${symbol} qualifies but DAMM_EDGE_ENABLED is not true; continuing DLMM evaluation`)
        } else if (openBlockedReason || openedCount >= availableOpenSlots) {
          const reason = openBlockedReason ?? 'slots_filled_this_tick'
          console.log(`[scanner][damm-edge] ${symbol} qualifies but DAMM open skipped: ${reason}; continuing DLMM evaluation`)
        } else {
          const openDammCount = getOpenDammEdgeCount(limitState) + openedDammCountThisTick
          if (openDammCount >= MAX_CONCURRENT_DAMM_POSITIONS) {
            console.log(
              `[scanner][damm-edge] max DAMM positions reached ` +
              `(${openDammCount}/${MAX_CONCURRENT_DAMM_POSITIONS}) — continuing DLMM evaluation`,
            )
          } else {
            const verifiedDammPool = await resolveVerifiedDammV2PoolForToken({
              tokenAddress,
              preferredPoolAddress: metrics.poolAddress,
              quoteMint: WSOL,
            })

            if (!verifiedDammPool) {
              console.log(`[scanner][damm-edge] ${symbol} has no verified DAMM v2 SOL pool; continuing DLMM evaluation`)
            } else {
              const dammParams = {
                ...dammDecision.params,
                poolAddress: verifiedDammPool.poolAddress,
                metadata: {
                  ...(dammDecision.params.metadata ?? {}),
                  damm_pool_resolver_source: verifiedDammPool.source,
                  scanner_source_pool_address: metrics.poolAddress,
                  verified_damm_pool_address: verifiedDammPool.poolAddress,
                  verified_damm_token_a_mint: verifiedDammPool.tokenAMint,
                  verified_damm_token_b_mint: verifiedDammPool.tokenBMint,
                },
              }

              console.log(
                `[scanner][damm-edge] TRIGGERED — opening verified DAMM v2 position for ${symbol} ` +
                `pool=${verifiedDammPool.poolAddress} source=${verifiedDammPool.source}`,
              )
              const result = await openDammPosition(dammParams)
              if (result.success) {
                openedCount++
                openedDammCountThisTick++
                openedMintsThisTick.add(tokenAddress)
                await sendAlert({
                  type:          'position_opened',
                  symbol,
                  strategy:      'damm-edge',
                  solDeposited:  dammParams.solAmount,
                  entryPrice:    metrics.priceUsd,
                  positionId:    result.positionId ?? result.positionPubkey,
                  poolAddress:   verifiedDammPool.poolAddress,
                  mint:          tokenAddress,
                })

                continue
              }

              console.error(`[scanner][damm-edge] openDammPosition failed for ${symbol}: ${result.error}; continuing DLMM evaluation`)
            }
          }
        }
      }
    }
    // ========== END DAMM v2 EDGE ================================================

    const tokenClass = lane === 'momentum' ? 'SCALP_SPIKE' : classifyToken({
      address:        metrics.address,
      mcUsd:          metrics.mcUsd,
      volume24h:      metrics.volume24h,
      volume1h:       vol1h,
      volume5m:       vol5m,
      liquidityUsd:   metrics.liquidityUsd,
      ageHours:       metrics.ageHours,
      topHolderPct:   metrics.topHolderPct,
      holderCount:    metrics.holderCount,
      rugcheckScore:  metrics.rugcheckScore,
      quoteTokenMint: metrics.quoteTokenMint,
      feeTvl1hPct:    metrics.feeTvl1hPct,
      feeTvl5mPct:    metrics.feeTvl5mPct,
      feeTvl24hPct:   metrics.feeTvl24hPct,
    })

    const forcedStrategyId = lane === 'momentum' ? 'scalp-spike' : 'evil-panda'
    const momentumRegain = lane === 'momentum' && passesMomentumRegain(bestPool)
    const strategy =
      getStrategyForToken({ ...metrics, volume1h: vol1h, volume5m: vol5m }, forcedStrategyId) ??
      (momentumRegain && passesMomentumRegainStrategyFilters(metrics) ? scalpSpikeStrategy : null)
    if (!strategy) {
      const rejectionReason = explainNoStrategy(metrics)
      console.log(`[scanner] ${symbol} — no strategy in ${lane} lane (class=${tokenClass}, quote=${quoteTokenMint}): ${rejectionReason}`)
      console.log(JSON.stringify({
        event:     'candidate_evaluated',
        mint:      tokenAddress,
        symbol,
        score:     0,
        lane,
        launchpad: launchpadSource,
        decision:  'REJECTED',
        reason:    rejectionReason,
      }))
      continue
    }

    if (strategy.id === 'scalp-spike' && momentumRegain) {
      console.log(
        `[scanner] ${symbol} — scalp-spike momentum-regain ` +
        `vol1h/24hAvg=${getOneHourVolumeVs24hAverage(bestPool).toFixed(2)}x ` +
        `fee1h/24hAvg=${getOneHourFeeTvlVs24hAverage(bestPool).toFixed(2)}x`,
      )
    }

    const breakdown = strategy.id === 'scalp-spike' && momentumRegain
      ? getMomentumRegainBreakdown(metrics)
      : scoreCandidateWithBreakdown(metrics, strategy)
    const score       = getScannerAdjustedScore(metrics, strategy.id, breakdown)
    const bondingInfo = bondingCurvePct !== undefined ? `, curve=${bondingCurvePct.toFixed(1)}%` : ''

    const accepted = lane === 'fresh' ? score > 0 : score >= MIN_SCORE_TO_OPEN
    const rejectionReason = !accepted
      ? lane === 'fresh'
        ? 'fresh safety check failed'
        : `score ${score} < threshold ${MIN_SCORE_TO_OPEN}`
      : null

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
      lane,
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
        scanner_lane:      lane,
        pool_address:      metrics.poolAddress,
        mc_at_scan:        metrics.mcUsd,
        volume_24h:        metrics.volume24h,
        volume_1h:         vol1h,
        volume_5m:         vol5m,
        liquidity_usd:     metrics.liquidityUsd,
        fee_tvl_24h_pct:   feeTvl24hPct,
        fee_tvl_1h_pct:    feeTvl1hPct,
        fee_tvl_5m_pct:    feeTvl5mPct,
        holder_count:      metrics.holderCount,
        rugcheck_score:    metrics.rugcheckScore,
        top_holder_pct:    metrics.topHolderPct,
        bin_step:          binStep,
        scanned_at:        new Date().toISOString(),
        score_volmc:       breakdown.volMcScore,
        score_holders:     breakdown.holderScore,
        score_freshness:   breakdown.freshnessScore,
        score_fee_efficiency: breakdown.feeEfficiencyScore,
        score_volume_tvl:  breakdown.volumeTvlScore,
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
    console.log(`[scanner] CANDIDATE: ${symbol} → ${strategy.id} (${lane} lane, class=${tokenClass}, quote=${quoteTokenMint}, score=${score}, mc=$${resolvedMc.toFixed(0)}, vol=$${vol24h.toFixed(0)}, vol1h=$${vol1h.toFixed(0)}, vol5m=$${vol5m.toFixed(0)}, feeTvl24h=${feeTvl24hPct.toFixed(2)}%, feeTvl1h=${feeTvl1hPct.toFixed(2)}%, feeTvl5m=${feeTvl5mPct.toFixed(2)}%, volTvl1h=${volumeTvl1hRatio.toFixed(2)}, momentum=${momentumScore}, holders=${holderCountForFilter}, rug=${rugScore}, age=${ageHours.toFixed(1)}h, binStep=${binStepDisplay}${bondingInfo})`)
    await sendAlert({ type: 'candidate_found', symbol, strategy: strategy.id, score, mcUsd: metrics.mcUsd, volume24h: metrics.volume24h, bondingCurvePct })

    if (accepted) {
      const disabledReason = getDisabledStrategyReason(strategy.id)
      if (disabledReason) {
        openSkippedCount++
        console.log(`[scanner] ${symbol} qualifies for ${strategy.id} but open skipped: ${disabledReason}`)
        continue
      }

      if (openBlockedReason || openedCount >= availableOpenSlots) {
        openSkippedCount++
        const reason = openBlockedReason ?? 'slots_filled_this_tick'
        console.log(`[scanner] ${symbol} qualifies but open skipped: ${reason}`)
        continue
      }

      const positionId = await openPosition(metrics, strategy)
      if (positionId) {
        openedCount++
        openedMintsThisTick.add(tokenAddress)
        await sendAlert({
          type: 'position_opened',
          symbol,
          strategy: strategy.id,
          solDeposited: MARKET_LP_SOL_PER_POSITION,
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

async function fetchMeteoraPoolsPage(baseUrl: string, sortBy: 'pool_created_at' | 'volume_5m' | 'volume_1h'): Promise<MeteoraPool[]> {
  const params: Record<string, string | number> = {
    page: 1,
    page_size: METEORA_FILTERED_FETCH.limit,
    limit: METEORA_FILTERED_FETCH.limit,
    sort: `${sortBy}:desc`,
    sort_by: `${sortBy}:desc`,
    'tvl>': METEORA_FILTERED_FETCH.minTvlUsd,
    'tvl[gte]': METEORA_FILTERED_FETCH.minTvlUsd,
  }
  if (METEORA_FILTERED_FETCH.minFeeTvlRatio1h > 0) {
    params['fee_tvl_ratio_1h>'] = METEORA_FILTERED_FETCH.minFeeTvlRatio1h
    params['fee_tvl_ratio_1h[gte]'] = METEORA_FILTERED_FETCH.minFeeTvlRatio1h
    params['min_fee_tvl_ratio_1h'] = METEORA_FILTERED_FETCH.minFeeTvlRatio1h
  }

  const res = await axios.get<unknown>(`${baseUrl}/pools`, {
    params,
    timeout: METEORA_FETCH_TIMEOUT_MS,
  })
  return normalizeMeteoraPoolsResponse(res.data)
}

async function fetchMeteoraPoolsFromEndpoint(baseUrl: string): Promise<MeteoraPool[]> {
  const poolMap = new Map<string, MeteoraPool>()
  let newestPools: MeteoraPool[] = []
  try {
    newestPools = await fetchMeteoraPoolsPage(baseUrl, 'pool_created_at')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[scanner] ${baseUrl}/pools newest-first fetch failed: ${message}`)
  }
  for (const pool of newestPools) poolMap.set(pool.address, pool)

  const momentumPages = await Promise.allSettled([
    fetchMeteoraPoolsPage(baseUrl, 'volume_1h'),
    fetchMeteoraPoolsPage(baseUrl, 'volume_5m'),
  ])
  for (const page of momentumPages) {
    if (page.status !== 'fulfilled') continue
    for (const pool of page.value) poolMap.set(pool.address, pool)
  }
  const pools = Array.from(poolMap.values())
    .sort((a, b) => poolSortTimestamp(b) - poolSortTimestamp(a))
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
    const isFresh = getPoolAgeMinutes(p) <= FRESH_MAX_AGE_MINUTES
    const isRegain = passesMomentumRegain(p)
    const minLiquidityUsd = isFresh ? FRESH_MIN_LIQUIDITY_USD : PRE_FILTER.minLiquidityUsd
    if (getPoolTvl(p) < minLiquidityUsd) return false
    if (getPoolTvl(p) > PRE_FILTER.maxLiquidityUsd) return false
    const hasQuote = QUOTE_ASSETS.has(p.token_x.address) || QUOTE_ASSETS.has(p.token_y.address)
    if (!hasQuote) return false
    const hasFeeTvl = getFeeTvlRatio(p, '1h') >= METEORA_FILTERED_FETCH.minFeeTvlRatio1h
    const hasVolumeTvl = getVolumeTvlRatio(p, '1h') >= METEORA_FILTERED_FETCH.minVolumeTvl1hRatio
    if (!isRegain && !hasFeeTvl && !hasVolumeTvl) return false
    const hasMomentumVolume = getPoolVolume(p, '5m') >= MOMENTUM_MIN_VOLUME_5M_USD
    if (!isFresh && !hasMomentumVolume && !isRegain) return false
    return true
  })

  console.log(
    `[scanner] ${allPools.length} filtered Meteora pools fetched; ${pools.length} passed JS pre-filter ` +
    `(minTvl=$${METEORA_FILTERED_FETCH.minTvlUsd}, ` +
    `minFeeTvl1h=${(METEORA_FILTERED_FETCH.minFeeTvlRatio1h * 100).toFixed(1)}%, ` +
    `minVolTvl1h=${METEORA_FILTERED_FETCH.minVolumeTvl1hRatio.toFixed(2)})`,
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
      maxOpen: MAX_CONCURRENT_MARKET_LP_POSITIONS,
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
