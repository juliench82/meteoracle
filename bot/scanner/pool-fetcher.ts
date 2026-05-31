import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { summarizeError } from '@/lib/logging'

const METEORA_DATAPI = 'https://dlmm.datapi.meteora.ag'
const METEORA_DLMM = 'https://dlmm-api.meteora.ag'

// Simple in-process cache — pools change slowly.
// Reduced to 5min default to keep momentum signals (vol5m, feeTvl5m) fresher for scalp-spike / evil-panda triggers.
let meteoraPoolsCache: { pools: MeteoraPool[]; ts: number } | null = null
const METEORA_CACHE_TTL_MS = parseInt(
  process.env.METEORA_POOLS_CACHE_TTL_MS ?? '300000',
  10,
)

// WARNING: Persisting the full Meteora pool list (often 1000-5000+ rows with large JSONB metadata + GIN index)
// to Supabase on every cache refresh is extremely expensive on Disk I/O.
// This is a primary contributor to "Disk IO budget" exhaustion warnings.
// Default is now OFF to protect Supabase resources. Only enable temporarily if you really need cross-restart warm cache.
const ENABLE_DB_POOL_CACHE_PERSIST = (process.env.SCANNER_PERSIST_POOL_CACHE ?? 'false').toLowerCase() === 'true'

function getCachedMeteoraPools(): MeteoraPool[] | null {
  if (!meteoraPoolsCache) return null
  if (Date.now() - meteoraPoolsCache.ts > METEORA_CACHE_TTL_MS) return null
  return meteoraPoolsCache.pools
}

export const WSOL = 'So11111111111111111111111111111111111111112'
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
export const QUOTE_ASSETS = new Set([WSOL, USDC, USDT])

export interface MeteoraToken {
  address: string
  symbol: string
  decimals: number
  holders: number
  market_cap: number
  price: number
}

export interface MeteoraPool {
  address: string
  name: string
  created_at?: number | string
  pool_created_at?: number | string
  tvl: number | string
  current_price: number
  volume?: { '24h'?: number | string; '1h'?: number | string; '30m'?: number | string; '5m'?: number | string }
  volume_24h?: number | string
  volume_1h?: number | string
  volume_5m?: number | string
  fees?: { '24h'?: number | string; '1h'?: number | string; '30m'?: number | string; '5m'?: number | string }
  fee_tvl_ratio?: { '24h'?: number | string; '1h'?: number | string; '30m'?: number | string; '5m'?: number | string }
  fee_tvl_ratio_24h?: number | string
  fee_tvl_ratio_1h?: number | string
  fee_tvl_ratio_5m?: number | string
  pool_config?: { bin_step?: number; base_fee_pct?: number }
  token_x: MeteoraToken
  token_y: MeteoraToken
  is_blacklisted: boolean
}

export type PoolFetchConfig = {
  minTvlUsd: number
  minFeeTvlRatio1h: number
  minVolumeTvl1hRatio: number
  limit: number
  timeoutMs: number
  freshMaxAgeMinutes: number
  freshMinLiquidityUsd: number
  minLiquidityUsd: number
  maxLiquidityUsd: number
  momentumMinVolume5mUsd: number
  isMomentumRegain: (pool: MeteoraPool) => boolean
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

export function getPoolCreatedAt(pool: MeteoraPool): number | null {
  const createdAt = pool.pool_created_at ?? pool.created_at
  if (!createdAt) return null
  const unixSeconds = toUnixSeconds(createdAt)
  return unixSeconds > 0 ? unixSeconds : null
}

export function getPoolAgeMinutes(pool: MeteoraPool): number {
  const createdAt = getPoolCreatedAt(pool)
  if (!createdAt) return 999_999
  return Math.max(0, (Date.now() / 1000 - createdAt) / 60)
}

export function getPoolVolume(pool: MeteoraPool, window: '24h' | '1h' | '5m'): number {
  const flatKey = `volume_${window}` as keyof MeteoraPool
  const direct = asNumber(pool.volume?.[window] ?? pool[flatKey], Number.NaN)
  if (Number.isFinite(direct)) return direct

  // Meteora currently returns 30m buckets on /pools but may omit 5m.
  // Use the 30m average as a conservative 5m proxy so momentum scans keep working.
  if (window === '5m') {
    const thirtyMinuteVolume = asNumber(pool.volume?.['30m'], Number.NaN)
    if (Number.isFinite(thirtyMinuteVolume)) return thirtyMinuteVolume / 6
  }

  return 0
}

export function getPoolTvl(pool: MeteoraPool): number {
  return asNumber(pool.tvl, 0)
}

export function getFeeTvlRatio(pool: MeteoraPool, window: '24h' | '1h' | '5m'): number {
  const flatKey = `fee_tvl_ratio_${window}` as keyof MeteoraPool
  const direct = asNumber(pool.fee_tvl_ratio?.[window] ?? pool[flatKey], Number.NaN)
  if (Number.isFinite(direct)) return direct

  if (window === '5m') {
    const thirtyMinuteRatio = asNumber(pool.fee_tvl_ratio?.['30m'], Number.NaN)
    if (Number.isFinite(thirtyMinuteRatio)) return thirtyMinuteRatio / 6
  }

  return 0
}

export function getFeeTvlPct(pool: MeteoraPool, window: '24h' | '1h' | '5m'): number {
  return getFeeTvlRatio(pool, window) * 100
}

export function getVolumeTvlRatio(pool: MeteoraPool, window: '1h' | '5m'): number {
  const tvl = getPoolTvl(pool)
  return tvl > 0 ? getPoolVolume(pool, window) / tvl : 0
}

export function getRecentVolumeGrowth(pool: MeteoraPool): number {
  const vol5mAnnualizedTo1h = getPoolVolume(pool, '5m') * 12
  const vol1h = getPoolVolume(pool, '1h')
  if (vol1h <= 0) return vol5mAnnualizedTo1h > 0 ? 3 : 0
  return vol5mAnnualizedTo1h / vol1h
}

export function scoreMeteoraMomentum(pool: MeteoraPool): number {
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

export function getQuoteTokenMint(pool: MeteoraPool): string {
  return QUOTE_ASSETS.has(pool.token_x.address)
    ? pool.token_x.address
    : pool.token_y.address
}

export function getTradableToken(pool: MeteoraPool): MeteoraToken {
  return QUOTE_ASSETS.has(pool.token_x.address) ? pool.token_y : pool.token_x
}

// ─── Supabase persistent cache ────────────────────────────────────────────────

async function loadDbPoolCache(): Promise<MeteoraPool[] | null> {
  try {
    const cutoff = new Date(Date.now() - METEORA_CACHE_TTL_MS).toISOString()
    const { data, error } = await createServerClient()
      .from('scanner_pool_cache')
      .select('metadata')
      .gte('last_seen_at', cutoff)
      .eq('is_blacklisted', false)

    if (error) throw error
    if (!data || data.length === 0) return null

    const pools = data
      .map((row: any) => normalizeMeteoraPool(row.metadata))
      .filter((p: any): p is MeteoraPool => p !== null)

    if (pools.length === 0) return null

    console.log(`[scanner] warm-start: loaded ${pools.length} pools from scanner_pool_cache`)
    return pools
  } catch (err) {
    console.warn(`[scanner] scanner_pool_cache read failed: ${summarizeError(err)}`)
    return null
  }
}

function persistDbPoolCache(pools: MeteoraPool[]): void {
  if (!ENABLE_DB_POOL_CACHE_PERSIST) {
    return // Disabled by default — full pool cache persistence is a major Disk IO consumer (large JSONB + GIN index)
  }
  if (pools.length === 0) return

  const now = new Date().toISOString()

  const rows = pools.map((pool) => {
    const tradable = getTradableToken(pool)
    const createdAt = getPoolCreatedAt(pool)
    return {
      pool_address: pool.address,
      token_address: tradable.address,
      symbol: tradable.symbol,
      scanner_lane: 'meteora',
      pool_created_at: createdAt ? new Date(createdAt * 1000).toISOString() : null,
      age_minutes: Math.round(getPoolAgeMinutes(pool)),
      liquidity_usd: getPoolTvl(pool),
      market_cap_usd: tradable.market_cap > 0 ? tradable.market_cap : null,
      volume_24h: getPoolVolume(pool, '24h') || null,
      volume_1h: getPoolVolume(pool, '1h') || null,
      volume_5m: getPoolVolume(pool, '5m') || null,
      fee_tvl_24h_pct: getFeeTvlPct(pool, '24h') || null,
      fee_tvl_1h_pct: getFeeTvlPct(pool, '1h') || null,
      fee_tvl_5m_pct: getFeeTvlPct(pool, '5m') || null,
      volume_spike_ratio: getRecentVolumeGrowth(pool) || null,
      momentum_score: scoreMeteoraMomentum(pool),
      is_blacklisted: pool.is_blacklisted,
      last_seen_at: now,
      metadata: pool as unknown as Record<string, unknown>,
      updated_at: now,
    }
  })

  const CHUNK = 200
  const chunks: typeof rows[] = []
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK))

  Promise.allSettled(
    chunks.map((chunk) =>
      createServerClient()
        .from('scanner_pool_cache')
        .upsert(chunk, { onConflict: 'pool_address', ignoreDuplicates: false }),
    ),
  ).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected')
    if (failed.length > 0) {
      console.warn(`[scanner] scanner_pool_cache upsert: ${failed.length}/${chunks.length} chunks failed`)
    }
  }).catch(() => { /* never throws */ })
}

/**
 * Cleans up old rows from scanner_pool_cache to protect Supabase Disk I/O budget.
 * Keeps rows seen in the last RETENTION_HOURS (default 48).
 *
 * This is now called automatically at the end of every scanner tick.
 *
 * WARNING: The full persist path (when SCANNER_PERSIST_POOL_CACHE=true) is extremely I/O heavy
 * due to large JSONB + GIN index maintenance. It is disabled by default for this reason.
 */
const POOL_CACHE_RETENTION_HOURS = parseInt(
  process.env.SCANNER_POOL_CACHE_RETENTION_HOURS ?? '48',
  10
)

export async function cleanupOldPoolCache(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - POOL_CACHE_RETENTION_HOURS * 60 * 60 * 1000).toISOString()

    const { error, count } = await createServerClient()
      .from('scanner_pool_cache')
      .delete({ count: 'exact' })
      .lt('last_seen_at', cutoff)

    if (error) throw error

    const deleted = count ?? 0
    if (deleted > 0) {
      console.log(`[scanner] cleaned ${deleted} old rows from scanner_pool_cache (retention=${POOL_CACHE_RETENTION_HOURS}h)`)
    }
    return deleted
  } catch (err) {
    console.warn(`[scanner] scanner_pool_cache cleanup failed: ${summarizeError(err)}`)
    return 0
  }
}

// ─── Meteora API fetchers ─────────────────────────────────────────────────────

async function fetchMeteoraPoolsPage(
  baseUrl: string,
  sortBy: 'pool_created_at' | 'volume_1h' | 'volume_5m',
  config: PoolFetchConfig,
): Promise<MeteoraPool[]> {
  const filters = [`tvl>=${config.minTvlUsd}`, 'is_blacklisted=false']
  const params: Record<string, string | number> = {
    page: 1,
    page_size: config.limit,
    limit: config.limit,
    sort_by: `${sortBy}:desc`,
    filter_by: filters.join(' && '),
  }

  const res = await axios.get<unknown>(`${baseUrl}/pools`, {
    params,
    timeout: config.timeoutMs,
  })
  return normalizeMeteoraPoolsResponse(res.data)
}

async function fetchMeteoraPoolsFromEndpoint(baseUrl: string, config: PoolFetchConfig): Promise<MeteoraPool[]> {
  const poolMap = new Map<string, MeteoraPool>()
  let newestPools: MeteoraPool[] = []
  try {
    newestPools = await fetchMeteoraPoolsPage(baseUrl, 'pool_created_at', config)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[scanner] ${baseUrl}/pools newest-first fetch failed: ${message}`)
  } for (const pool of newestPools) poolMap.set(pool.address, pool)

  const momentumPages = await Promise.allSettled([
    fetchMeteoraPoolsPage(baseUrl, 'volume_1h', config),
    fetchMeteoraPoolsPage(baseUrl, 'volume_5m', config),
  ])
  for (const page of momentumPages) {
    if (page.status !== 'fulfilled') continue
    for (const pool of page.value) poolMap.set(pool.address, pool)
  }
  const pools = Array.from(poolMap.values())
    .sort((a, b) => (getPoolCreatedAt(b) ?? 0) - (getPoolCreatedAt(a) ?? 0))
  if (pools.length > 0) return pools

  console.warn(`[scanner] ${baseUrl}/pools returned no usable pools; trying documented /pair/all fallback`)
  const fallback = await axios.get<unknown>(`${baseUrl}/pair/all`, {
    timeout: config.timeoutMs,
  })
  return normalizeMeteoraPoolsResponse(fallback.data)
}

export async function fetchMeteoraPools(config: PoolFetchConfig): Promise<{ pools: MeteoraPool[]; error?: string }> {
  // 1. In-process memory cache — always apply JS pre-filter so callers with
  //    different configs (e.g. telegram-bot vs lp-scanner) see consistent output.
  const cached = getCachedMeteoraPools()
  if (cached) {
    const pools = applyJsPreFilter(cached, config)
    console.log(
      `[scanner] using in-memory cached Meteora pools (${cached.length} entries, TTL ${Math.round(METEORA_CACHE_TTL_MS / 60000)}min)` +
      `; ${pools.length} passed JS pre-filter`,
    )
    return { pools }
  }

  // 2. Persistent DB cache (warm across restarts, same TTL window)
  const dbPools = await loadDbPoolCache()
  if (dbPools && dbPools.length > 0) {
    meteoraPoolsCache = { pools: dbPools, ts: Date.now() }
    const pools = applyJsPreFilter(dbPools, config)
    console.log(`[scanner] warm-start: ${dbPools.length} pools from DB; ${pools.length} passed JS pre-filter`)
    return { pools }
  }

  // 3. Live fetch from Meteora API
  let allPools: MeteoraPool[] = []
  for (const endpoint of [METEORA_DATAPI, METEORA_DLMM]) {
    try {
      console.log(`[scanner] trying Meteora endpoint: ${endpoint}`)
      allPools = await fetchMeteoraPoolsFromEndpoint(endpoint, config)
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

  meteoraPoolsCache = { pools: allPools, ts: Date.now() }
  console.log(`[scanner] cached ${allPools.length} Meteora pools for ${Math.round(METEORA_CACHE_TTL_MS / 60000)}min`)

  if (ENABLE_DB_POOL_CACHE_PERSIST) {
    persistDbPoolCache(allPools)
  } else {
    // Default behavior: skip the very expensive full-pool upsert to Supabase.
    // This dramatically reduces Disk I/O. Warm-start will only work from whatever data is already in the table.
  }

  const pools = applyJsPreFilter(allPools, config)
  console.log(
    `[scanner] ${allPools.length} filtered Meteora pools fetched; ${pools.length} passed JS pre-filter ` +
    `(minTvl=$${config.minTvlUsd}, ` +
    `minFeeTvl1h=${(config.minFeeTvlRatio1h * 100).toFixed(1)}%, ` +
    `minVolTvl1h=${config.minVolumeTvl1hRatio.toFixed(2)})`,
  )
  return { pools }
}

function applyJsPreFilter(allPools: MeteoraPool[], config: PoolFetchConfig): MeteoraPool[] {
  return allPools.filter((pool) => {
    if (pool.is_blacklisted) return false
    const isFresh = getPoolAgeMinutes(pool) <= config.freshMaxAgeMinutes
    const isRegain = config.isMomentumRegain(pool)
    const minLiquidityUsd = isFresh ? config.freshMinLiquidityUsd : config.minLiquidityUsd
    if (getPoolTvl(pool) < minLiquidityUsd) return false
    if (getPoolTvl(pool) > config.maxLiquidityUsd) return false
    const hasQuote = QUOTE_ASSETS.has(pool.token_x.address) || QUOTE_ASSETS.has(pool.token_y.address)
    if (!hasQuote) return false
    const hasFeeTvl = getFeeTvlRatio(pool, '1h') >= config.minFeeTvlRatio1h
    const hasVolumeTvl = getVolumeTvlRatio(pool, '1h') >= config.minVolumeTvl1hRatio
    if (!isRegain && !hasFeeTvl && !hasVolumeTvl) return false
    const hasMomentumVolume = getPoolVolume(pool, '5m') >= config.momentumMinVolume5mUsd
    if (!isFresh && !hasMomentumVolume && !isRegain) return false
    return true
  })
}
