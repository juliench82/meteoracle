import axios from 'axios'

const METEORA_DATAPI = 'https://dlmm.datapi.meteora.ag'
// dlmm-api.meteora.ag /pools (and /pair/all) deprecated/returning 404; datapi is the active public DLMM pool list endpoint.

// Simple in-process cache — pools change slowly.
// Cache TTL tuned for the fresh-only scanner (age ≤ MAX_POOL_AGE_MINUTES).
let meteoraPoolsCache: { pools: MeteoraPool[]; ts: number } | null = null
const METEORA_CACHE_TTL_MS = parseInt(
  process.env.METEORA_POOLS_CACHE_TTL_MS ?? '300000',
  10,
)

export function getCachedMeteoraPools(): MeteoraPool[] | null {
  if (!meteoraPoolsCache) return null
  if (Date.now() - meteoraPoolsCache.ts > METEORA_CACHE_TTL_MS) return null
  return meteoraPoolsCache.pools
}

export const WSOL = 'So11111111111111111111111111111111111111112'
export const SOL_MINT = WSOL
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
  // DBC 0.2.0+ transfer hook support (for graduated transfer-hook pools)
  transfer_hook_program?: string | null
  has_transfer_hook?: boolean
}

export type PoolFetchConfig = {
  minTvlUsd: number
  limit: number
  timeoutMs: number
  maxPoolAgeMinutes: number
  minLiquidityUsd: number
  maxLiquidityUsd: number
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
    transfer_hook_program: asString(getRecordValue(pool, ['transfer_hook_program', 'transferHookProgram', 'transfer_hook'])) ?? undefined,
    has_transfer_hook: !!(getRecordValue(pool, ['transfer_hook_program', 'transferHookProgram', 'has_transfer_hook', 'transfer_hook'])),
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
  // Use the 30m average as a conservative recent activity signal (kept for compatibility during transition).
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

// (scoreMeteoraMomentum fully removed — no longer used)

export function getQuoteTokenMint(pool: MeteoraPool): string {
  return QUOTE_ASSETS.has(pool.token_x.address)
    ? pool.token_x.address
    : pool.token_y.address
}

export function getTradableToken(pool: MeteoraPool): MeteoraToken {
  return QUOTE_ASSETS.has(pool.token_x.address) ? pool.token_y : pool.token_x
}

// ─── Meteora API fetchers ─────────────────────────────────────────────────────

async function fetchMeteoraPoolsPage(
  baseUrl: string,
  sortBy: 'pool_created_at' | 'volume_1h' | 'volume_5m',
  config: PoolFetchConfig,
  page = 1,
): Promise<MeteoraPool[]> {
  const filters = ['is_blacklisted=false']
  if (config.minTvlUsd > 0) {
    filters.unshift(`tvl>=${config.minTvlUsd}`)
  }
  const params: Record<string, string | number> = {
    page,
    page_size: Math.min(config.limit, 100), // API seems sensitive to large sizes sometimes
    sort_by: `${sortBy}:desc`,
    filter_by: filters.join(' && '),
  }

  // Simple retry for transient 4xx/5xx on Meteora public API
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get<unknown>(`${baseUrl}/pools`, {
        params,
        timeout: config.timeoutMs,
      })
      return normalizeMeteoraPoolsResponse(res.data)
    } catch (err) {
      if (attempt === 1) throw err
      console.warn(`[scanner] ${baseUrl}/pools attempt ${attempt + 1} failed, retrying...`)
      await new Promise(r => setTimeout(r, 300))
    }
  }
  return []
}

export async function fetchMeteoraPoolsFromEndpoint(baseUrl: string, config: PoolFetchConfig): Promise<MeteoraPool[]> {
  const poolMap = new Map<string, MeteoraPool>()
  const MAX_PAGES = 20 // safety cap; 100/page *20 = 2000 pools max
  let page = 1
  let pagesFetched = 0
  let reachedAgeLimit = false

  while (page <= MAX_PAGES) {
    let pagePools: MeteoraPool[] = []
    try {
      pagePools = await fetchMeteoraPoolsPage(baseUrl, 'pool_created_at', config, page)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[scanner] ${baseUrl}/pools page ${page} fetch failed: ${message}`)
      break
    }
    if (pagePools.length === 0) break

    pagesFetched = page
    for (const pool of pagePools) {
      if (!poolMap.has(pool.address)) poolMap.set(pool.address, pool)
    }

    // If this page contains pools older than our max age, no need to fetch further pages (newer pages first).
    const pageAges = pagePools
      .map(p => getPoolAgeMinutes(p))
      .filter(a => a < 1_000_000)
    const oldestAgeInPage = pageAges.length > 0 ? Math.max(...pageAges) : 0
    if (oldestAgeInPage > config.maxPoolAgeMinutes) {
      reachedAgeLimit = true
      break
    }

    page++
  }

  if (pagesFetched > 1) {
    console.log(`[scanner] paginated ${pagesFetched} page(s) from ${baseUrl} (reachedAgeLimit=${reachedAgeLimit})`)
  }

  // In the ultra-minimal model we only care about recent SOL-paired pools by age (≤ MAX_POOL_AGE_MINUTES).
  // Extra volume-sorted fetches have been removed.
  const pools = Array.from(poolMap.values())
    .sort((a, b) => (getPoolCreatedAt(b) ?? 0) - (getPoolCreatedAt(a) ?? 0))
  if (pools.length > 0) return pools

  // No pools from this endpoint's /pools (either empty or fetch failed inside).
  return []
}

export async function fetchMeteoraPools(config: PoolFetchConfig): Promise<{ pools: MeteoraPool[]; error?: string; rawCount?: number }> {
  // 1. In-process memory cache — always apply JS pre-filter so callers with
  //    different configs (e.g. telegram-bot vs lp-scanner) see consistent output.
  //    Pre-filter now strictly requires SOL side (for evil-panda one-sided SOL strategy).
  const cached = getCachedMeteoraPools()
  if (cached) {
    const pools = applyJsPreFilter(cached, config)
    console.log(
      `[scanner] using in-memory cached Meteora pools (${cached.length} entries, TTL ${Math.round(METEORA_CACHE_TTL_MS / 60000)}min)` +
      `; ${pools.length} passed JS pre-filter (age≤${config.maxPoolAgeMinutes}m + SOL-paired + !blacklist)`,
    )
    return { pools, rawCount: cached.length }
  }

  // 2. Live fetch from Meteora API (no persistent DB warm cache in simplified model)
  // datapi is the supported public endpoint for DLMM pool listing.
  const poolMap = new Map<string, MeteoraPool>()
  const endpoint = METEORA_DATAPI
  try {
    console.log(`[scanner] trying Meteora endpoint: ${endpoint}`)
    const endpointPools = await fetchMeteoraPoolsFromEndpoint(endpoint, config)
    for (const p of endpointPools) {
      if (!poolMap.has(p.address)) poolMap.set(p.address, p)
    }
    if (endpointPools.length > 0) {
      console.log(`[scanner] ${endpoint} returned ${endpointPools.length} pools`)
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const status = (err as { response?: { status?: number } })?.response?.status
    console.warn(`[scanner] endpoint ${endpoint} failed: ${status ? `HTTP ${status}: ` : ''}${message}`)
  }

  const allPools = Array.from(poolMap.values())
  if (allPools.length === 0) {
    return { pools: [], error: 'All Meteora endpoints failed or returned empty', rawCount: 0 }
  }

  meteoraPoolsCache = { pools: allPools, ts: Date.now() }
  console.log(`[scanner] cached ${allPools.length} Meteora pools for ${Math.round(METEORA_CACHE_TTL_MS / 60000)}min`)

  const pools = applyJsPreFilter(allPools, config)
  console.log(
    `[scanner] ${allPools.length} Meteora pools from API; ${pools.length} passed JS pre-filter ` +
    `(age≤${config.maxPoolAgeMinutes}m + SOL-paired + !blacklist, minTvl=$${config.minTvlUsd})`,
  )
  return { pools, rawCount: allPools.length }
}

function applyJsPreFilter(allPools: MeteoraPool[], config: PoolFetchConfig): MeteoraPool[] {
  return allPools.filter((pool) => {
    if (pool.is_blacklisted) return false
    const ageMin = getPoolAgeMinutes(pool)
    if (ageMin > config.maxPoolAgeMinutes) return false

    // Only apply liquidity filter if positive thresholds are provided
    if (config.minLiquidityUsd > 0 && getPoolTvl(pool) < config.minLiquidityUsd) return false
    if (config.maxLiquidityUsd > 0 && getPoolTvl(pool) > config.maxLiquidityUsd) return false

    // Evil-panda is SOL-paired only (one-sided SOL zap-in / direct). Reject USDC/USDT-paired or other.
    // This prevents non-SOL pairs from reaching deep-check, ACCEPT, then late "pool has no SOL side" reject in executor.
    const hasSolSide = pool.token_x.address === SOL_MINT || pool.token_y.address === SOL_MINT
    if (!hasSolSide) return false
    return true
  })
}

/**
 * Returns the most recent 24h Fee/TVL % for a specific pool address.
 * Prefers the in-memory cache populated by the scanner (fresh within TTL).
 * Falls back to a relaxed fetch of recent pools if cache miss (used by monitor for open positions).
 */
export async function getCurrentPoolFeeTvl24h(poolAddress: string): Promise<number | null> {
  // 1. Hot path: in-memory cache from last scanner tick
  const cached = getCachedMeteoraPools()
  if (cached) {
    const hit = cached.find((p) => p.address === poolAddress)
    if (hit) {
      const v = getFeeTvlPct(hit, '24h')
      if (Number.isFinite(v) && v > 0) return v
    }
  }

  // 2. Cold fallback: fetch a broad recent set (no strict pre-filter) and lookup
  try {
    const relaxedConfig: PoolFetchConfig = {
      minTvlUsd: 0,
      limit: 2000,
      timeoutMs: 20_000,
      maxPoolAgeMinutes: 60 * 24 * 30, // allow old pools for monitoring existing positions
      minLiquidityUsd: 0,
      maxLiquidityUsd: Number.MAX_SAFE_INTEGER,
    }
    // Use the internal fetcher directly to avoid heavy JS pre-filter
    let pools: MeteoraPool[] = []
    try {
      pools = await fetchMeteoraPoolsFromEndpoint(METEORA_DATAPI, relaxedConfig)
    } catch {
      // best-effort; pools will stay []
    }
    const hit = pools.find((p) => p.address === poolAddress)
    if (hit) {
      const v = getFeeTvlPct(hit, '24h')
      return Number.isFinite(v) && v > 0 ? v : null
    }
  } catch (e) {
    console.warn(`[pool-fetcher] getCurrentPoolFeeTvl24h fallback failed for ${poolAddress}:`, e instanceof Error ? e.message : e)
  }
  return null
}
