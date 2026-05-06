import { Connection, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { createConnection, getConnection, getRpcEndpointCandidates, getWalletPublicKey } from '@/lib/solana'
import { getDammSolPriceFromPoolState } from '@/lib/damm-price'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const DEXSCREENER_SOLANA_PAIR_API = 'https://api.dexscreener.com/latest/dex/pairs/solana'
const DEXSCREENER_TOKEN_API = 'https://api.dexscreener.com/latest/dex/tokens'
const METEORA_DLMM_POSITION_API = 'https://dlmm-api.meteora.ag/position'
const DEX_PAIR_CACHE_TTL_MS = 20_000
const DLMM_POSITION_STATS_CACHE_TTL_MS = 60_000
const _pairInfoCache = new Map<string, { value: DexPairInfo | null; expiresAt: number }>()
const _dlmmPositionStatsCache = new Map<string, { value: Record<string, number | null> | null; expiresAt: number }>()
const _mintDecimalsCache = new Map<string, number | null>()
const CLOSED_LIVE_REOPEN_GRACE_MS =
  parseInt(process.env.METEORA_CLOSED_LIVE_REOPEN_GRACE_SEC ?? '180', 10) * 1_000
const PNL_PCT_KEYS = [
  'position_pnl_pct',
  'position_pnl_percentage',
  'pnl_pct',
  'pnl_percentage',
  'total_pnl_pct',
  'total_pnl_percentage',
  'pnlPercent',
  'pnlPercentage',
]

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

async function getCpAmm(connection: Connection = getConnection()): Promise<any> {
  const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')
  return new CpAmm(connection)
}

function toNumber(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') return Number(value) || 0
  if (typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    try {
      return (value as { toNumber: () => number }).toNumber()
    } catch {
      // Some SDK BN/u128 values are too large for toNumber(); fall through to toString.
    }
  }
  if (typeof (value as { toString?: unknown }).toString === 'function') {
    return Number((value as { toString: () => string }).toString()) || 0
  }
  return Number(value) || 0
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toBn(value: unknown): BN {
  if (BN.isBN(value)) return value as BN
  if (typeof value === 'bigint') return new BN(value.toString())
  if (typeof value === 'number') return new BN(Math.trunc(value).toString())
  if (typeof (value as { toString?: unknown })?.toString === 'function') {
    return new BN((value as { toString: () => string }).toString())
  }
  return new BN(0)
}

function toBase58(value: unknown): string {
  if (value instanceof PublicKey) return value.toBase58()
  if (value && typeof (value as { toBase58?: unknown }).toBase58 === 'function') {
    return (value as { toBase58: () => string }).toBase58()
  }
  return String(value ?? '')
}

interface DexPairInfo {
  pairAddress?: string
  url?: string
  priceUsd?: string
  priceNative?: string
  liquidity?: { usd?: number; base?: number; quote?: number }
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number }
  baseToken?: { address?: string; symbol?: string }
  quoteToken?: { address?: string; symbol?: string }
}

interface TokenDeposit {
  mint: string
  symbol: string
  amount: number
}

function normalizeSymbolPart(symbol: unknown): string {
  const s = String(symbol ?? '').trim()
  if (!s) return ''
  return s.toUpperCase() === 'WSOL' ? 'SOL' : s
}

function pairSymbol(base: unknown, quote: unknown): string {
  const baseSymbol = normalizeSymbolPart(base)
  const quoteSymbol = normalizeSymbolPart(quote)
  if (baseSymbol && quoteSymbol) return `${baseSymbol}-${quoteSymbol}`
  return ''
}

function symbolFromPositionInfo(positionInfo: any): string {
  const tokenXSymbol = positionInfo?.tokenX?.symbol ?? positionInfo?.tokenX?.name
  const tokenYSymbol = positionInfo?.tokenY?.symbol ?? positionInfo?.tokenY?.name
  const tokenXMint = toBase58(positionInfo?.tokenX?.publicKey)
  const tokenYMint = toBase58(positionInfo?.tokenY?.publicKey)

  if (tokenYMint === SOL_MINT && !tokenXSymbol) return ''
  if (tokenXMint === SOL_MINT && !tokenYSymbol) return ''
  if (tokenYMint === SOL_MINT) return pairSymbol(tokenXSymbol, 'SOL')
  if (tokenXMint === SOL_MINT) return pairSymbol(tokenYSymbol, 'SOL')
  return pairSymbol(tokenXSymbol, tokenYSymbol)
}

function symbolFromDexPair(pair: DexPairInfo | null): string {
  if (!pair) return ''
  return pairSymbol(pair.baseToken?.symbol, pair.quoteToken?.symbol)
}

async function fetchDexJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

function getCached<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string): T | undefined {
  const cached = cache.get(key)
  if (!cached) return undefined
  if (cached.expiresAt > Date.now()) return cached.value
  cache.delete(key)
  return undefined
}

function setCached<T>(cache: Map<string, { value: T; expiresAt: number }>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs })
}

async function fetchDexPairByPool(poolAddress: string): Promise<DexPairInfo | null> {
  if (!poolAddress) return null
  const cacheKey = `pool:${poolAddress}`
  const cached = getCached(_pairInfoCache, cacheKey)
  if (cached !== undefined) return cached

  const data = await fetchDexJson(`${DEXSCREENER_SOLANA_PAIR_API}/${poolAddress}`)
  const pair = (data?.pair ?? data?.pairs?.[0] ?? null) as DexPairInfo | null
  setCached(_pairInfoCache, cacheKey, pair, DEX_PAIR_CACHE_TTL_MS)
  return pair
}

async function fetchDexPairByToken(mint: string, poolAddress?: string): Promise<DexPairInfo | null> {
  if (!mint) return null
  const cacheKey = `token:${mint}:${poolAddress ?? ''}`
  const cached = getCached(_pairInfoCache, cacheKey)
  if (cached !== undefined) return cached

  const data = await fetchDexJson(`${DEXSCREENER_TOKEN_API}/${mint}`)
  const pairs = Array.isArray(data?.pairs) ? data.pairs as DexPairInfo[] : []
  const exactPool = poolAddress
    ? pairs.find(p => p.pairAddress?.toLowerCase() === poolAddress.toLowerCase())
    : null
  const solPair = pairs.find(p =>
    p.quoteToken?.address === SOL_MINT ||
    p.baseToken?.address === SOL_MINT ||
    normalizeSymbolPart(p.quoteToken?.symbol) === 'SOL' ||
    normalizeSymbolPart(p.baseToken?.symbol) === 'SOL'
  )
  const pair = exactPool ?? solPair ?? pairs[0] ?? null
  setCached(_pairInfoCache, cacheKey, pair, DEX_PAIR_CACHE_TTL_MS)
  return pair
}

async function fetchMintDecimals(mint: string, connection: Connection = getConnection()): Promise<number | null> {
  if (!mint) return null
  if (mint === SOL_MINT) return 9
  if (_mintDecimalsCache.has(mint)) return _mintDecimalsCache.get(mint) ?? null

  try {
    const account = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed')
    const decimals = parseDecimalCount((account.value?.data as any)?.parsed?.info?.decimals)
    _mintDecimalsCache.set(mint, decimals)
    return decimals
  } catch {
    _mintDecimalsCache.set(mint, null)
    return null
  }
}

async function resolveLiveSymbol(
  mint: string,
  poolAddress: string,
  fallbackPrefix: 'LIVE' | 'DAMM',
  positionInfo?: any,
): Promise<{ symbol: string; dexUrl?: string; pair?: DexPairInfo | null }> {
  const localSymbol = positionInfo ? symbolFromPositionInfo(positionInfo) : ''
  const pair = await fetchDexPairByPool(poolAddress) ?? await fetchDexPairByToken(mint, poolAddress)
  if (localSymbol) return { symbol: localSymbol, dexUrl: pair?.url, pair }
  const dexSymbol = symbolFromDexPair(pair)
  if (dexSymbol) return { symbol: dexSymbol, dexUrl: pair?.url, pair }

  return { symbol: `${fallbackPrefix}-${mint.slice(0, 6)}`, pair }
}

function extractPositions(positionInfo: any): any[] {
  if (Array.isArray(positionInfo?.lbPairPositionsData)) return positionInfo.lbPairPositionsData
  if (Array.isArray(positionInfo?.userPositions)) return positionInfo.userPositions
  if (positionInfo?.publicKey && positionInfo?.positionData) return [positionInfo]
  return []
}

function resolveMint(positionInfo: any): string {
  const tokenX = toBase58(positionInfo?.tokenX?.publicKey)
  const tokenY = toBase58(positionInfo?.tokenY?.publicKey)
  if (tokenY === SOL_MINT && tokenX) return tokenX
  if (tokenX === SOL_MINT && tokenY) return tokenY
  return tokenX || tokenY
}

function estimateSolDeposited(positionData: any, positionInfo: any): number {
  const tokenX = toBase58(positionInfo?.tokenX?.publicKey)
  const tokenY = toBase58(positionInfo?.tokenY?.publicKey)
  if (tokenX === SOL_MINT) return toNumber(positionData?.totalXAmount) / 1e9
  if (tokenY === SOL_MINT) return toNumber(positionData?.totalYAmount) / 1e9
  return 0
}

function parseDecimalCount(value: unknown): number | null {
  if (value == null) return null

  let n: number
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'bigint') {
    n = Number(value)
  } else if (typeof value === 'string') {
    n = Number(value)
  } else if (typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    try {
      n = (value as { toNumber: () => number }).toNumber()
    } catch {
      return null
    }
  } else {
    return null
  }

  return Number.isInteger(n) && n >= 0 && n <= 18 ? n : null
}

function tokenDecimals(token: unknown, mint?: string): number | null {
  const tokenLike = token as { decimals?: unknown; decimal?: unknown; mint?: { decimals?: unknown; decimal?: unknown } } | null
  const candidates = [
    parseDecimalCount(token),
    parseDecimalCount(tokenLike?.decimals),
    parseDecimalCount(tokenLike?.decimal),
    parseDecimalCount(tokenLike?.mint?.decimals),
    parseDecimalCount(tokenLike?.mint?.decimal),
  ]

  for (const candidate of candidates) {
    if (candidate !== null) return candidate
  }

  if (mint === SOL_MINT) return 9
  return null
}

function uiAmount(raw: unknown, decimals: number | null): number | null {
  if (decimals === null) return null
  const amount = toNumber(raw)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return amount / 10 ** decimals
}

function tokenSymbol(token: unknown, mint: string, pair?: DexPairInfo | null): string {
  const tokenLike = token as { symbol?: unknown; name?: unknown } | null
  const localSymbol = normalizeSymbolPart(tokenLike?.symbol ?? tokenLike?.name)
  if (localSymbol) return localSymbol
  if (mint === SOL_MINT) return 'SOL'
  if (pair?.baseToken?.address === mint) return normalizeSymbolPart(pair.baseToken.symbol) || mint.slice(0, 4)
  if (pair?.quoteToken?.address === mint) return normalizeSymbolPart(pair.quoteToken.symbol) || mint.slice(0, 4)
  return mint.slice(0, 4)
}

function depositComponents(...deposits: Array<TokenDeposit | null>): TokenDeposit[] {
  return deposits.filter((deposit): deposit is TokenDeposit =>
    deposit !== null &&
    Number.isFinite(deposit.amount) &&
    deposit.amount > 0,
  )
}

function solUsdPrice(tokenXMint: string, tokenYMint: string, tokenXUsd: number | null, tokenYUsd: number | null): number | null {
  if (tokenXMint === SOL_MINT) return tokenXUsd
  if (tokenYMint === SOL_MINT) return tokenYUsd
  return null
}

function usdAmount(amount: number | null, priceUsd: number | null): number | null {
  if (amount === null || priceUsd === null) return null
  return amount * priceUsd
}

function sumUsd(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (!valid.length) return null
  return roundUsd(valid.reduce((sum, value) => sum + value, 0))
}

function roundUsd(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100) / 100
}

function roundMoney(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100) / 100
}

function roundPct(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.round(value * 100) / 100
}

function getFirstFiniteRecordNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberOrNull(record[key])
    if (value !== null) return value
  }
  return null
}

function inferUsdPrices(pair: DexPairInfo | null | undefined, tokenXMint: string, tokenYMint: string): {
  tokenXUsd: number | null
  tokenYUsd: number | null
} {
  if (!pair) return { tokenXUsd: null, tokenYUsd: null }

  const baseMint = pair.baseToken?.address
  const quoteMint = pair.quoteToken?.address
  const priceUsd = Number(pair.priceUsd)
  const priceNative = Number(pair.priceNative)
  let baseUsd = Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null
  let quoteUsd: number | null = null

  if (quoteMint === SOL_MINT && baseUsd !== null && Number.isFinite(priceNative) && priceNative > 0) {
    quoteUsd = baseUsd / priceNative
  }
  if (baseMint === SOL_MINT && baseUsd !== null) {
    quoteUsd = Number.isFinite(priceNative) && priceNative > 0 ? baseUsd / priceNative : quoteUsd
  }
  if (baseMint && quoteMint && baseUsd !== null && quoteUsd === null && Number.isFinite(priceNative) && priceNative > 0) {
    quoteUsd = baseUsd / priceNative
  }

  return {
    tokenXUsd: tokenXMint === baseMint ? baseUsd : tokenXMint === quoteMint ? quoteUsd : tokenXMint === SOL_MINT ? quoteUsd ?? baseUsd : null,
    tokenYUsd: tokenYMint === baseMint ? baseUsd : tokenYMint === quoteMint ? quoteUsd : tokenYMint === SOL_MINT ? quoteUsd ?? baseUsd : null,
  }
}

function estimateDlmmUsdFields(positionData: any, positionInfo: any, pair: DexPairInfo | null | undefined): {
  claimableFeesUsd: number | null
  positionValueUsd: number | null
  deposits: TokenDeposit[]
  solPriceUsd: number | null
} {
  const tokenXMint = toBase58(positionInfo?.tokenX?.publicKey)
  const tokenYMint = toBase58(positionInfo?.tokenY?.publicKey)
  const tokenXDecimals = tokenDecimals(positionInfo?.tokenX, tokenXMint)
  const tokenYDecimals = tokenDecimals(positionInfo?.tokenY, tokenYMint)
  const { tokenXUsd, tokenYUsd } = inferUsdPrices(pair, tokenXMint, tokenYMint)

  const feeX = uiAmount(positionData?.feeX, tokenXDecimals)
  const feeY = uiAmount(positionData?.feeY, tokenYDecimals)
  const totalX = uiAmount(positionData?.totalXAmount, tokenXDecimals)
  const totalY = uiAmount(positionData?.totalYAmount, tokenYDecimals)

  const claimableFeesUsd = sumUsd([
    usdAmount(feeX, tokenXUsd),
    usdAmount(feeY, tokenYUsd),
  ])
  const positionValueUsd = sumUsd([
    usdAmount(totalX, tokenXUsd),
    usdAmount(totalY, tokenYUsd),
  ])
  const deposits = depositComponents(
    totalX !== null
      ? { mint: tokenXMint, symbol: tokenSymbol(positionInfo?.tokenX, tokenXMint, pair), amount: totalX }
      : null,
    totalY !== null
      ? { mint: tokenYMint, symbol: tokenSymbol(positionInfo?.tokenY, tokenYMint, pair), amount: totalY }
      : null,
  )

  return {
    claimableFeesUsd,
    positionValueUsd,
    deposits,
    solPriceUsd: solUsdPrice(tokenXMint, tokenYMint, tokenXUsd, tokenYUsd),
  }
}

function deriveLiveDlmmPnlUsd(
  solDeposited: number,
  usdFields: {
    claimableFeesUsd: number | null
    positionValueUsd: number | null
    solPriceUsd: number | null
  },
): number | null {
  if (solDeposited <= 0 || usdFields.positionValueUsd === null || usdFields.solPriceUsd === null) return null
  const costBasisUsd = solDeposited * usdFields.solPriceUsd
  if (costBasisUsd <= 0) return null
  return roundMoney(
    usdFields.positionValueUsd +
    (usdFields.claimableFeesUsd ?? 0) -
    costBasisUsd,
  )
}

function deriveOpenPnlPct(
  pnlUsd: number | null,
  solDeposited: number,
  usdFields: {
    claimableFeesUsd: number | null
    positionValueUsd: number | null
    solPriceUsd: number | null
  },
): number | null {
  if (solDeposited <= 0 || usdFields.solPriceUsd === null) return null
  const costBasisUsd = solDeposited * usdFields.solPriceUsd
  if (costBasisUsd <= 0) return null
  const resolvedPnlUsd = pnlUsd ?? deriveLiveDlmmPnlUsd(solDeposited, usdFields)
  if (resolvedPnlUsd === null) return null
  return roundPct((resolvedPnlUsd / costBasisUsd) * 100)
}

function openedAtFromPosition(positionData: any): string {
  const ts = toNumber(positionData?.lastUpdatedAt)
  if (ts > 0) return new Date(ts * 1000).toISOString()
  return new Date().toISOString()
}

function resolveDammMint(poolState: any): string {
  const tokenA = toBase58(poolState?.tokenAMint)
  const tokenB = toBase58(poolState?.tokenBMint)
  if (tokenA === SOL_MINT && tokenB) return tokenB
  if (tokenB === SOL_MINT && tokenA) return tokenA
  return tokenA || tokenB
}

async function fetchMeteoraDammPositionFields(positionPubkey: string): Promise<{
  claimableFeesUsd: number | null
  positionValueUsd: number | null
  feesClaimedUsd: number | null
  totalFeeEarnedUsd: number | null
  totalPnlUsd: number | null
  deposits: TokenDeposit[]
} | null> {
  try {
    const res = await fetch(`https://amm-v2.meteora.ag/position/${positionPubkey}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()

    const claimableFeesUsd = data.fee_pending_usd ?? data.total_fee_usd ?? data.claimable_fee_usd ?? null
    const positionValueUsd = data.position_value_usd ?? data.total_value_usd ?? data.value_usd ?? null
    const feesClaimedUsd = data.total_fee_usd_claimed ?? data.total_fee_claimed_usd ?? data.fee_claimed_usd ?? null
    const totalFeeEarnedUsd = data.total_fee_earned_usd ?? data.total_fees_earned_usd ?? null
    const totalPnlUsd = data.position_pnl_usd ?? data.pnl_usd ?? data.total_pnl_usd ?? null
    const tokenADecimals = parseDecimalCount(data.token_a_decimals ?? data.tokenADecimals)
    const tokenBDecimals = parseDecimalCount(data.token_b_decimals ?? data.tokenBDecimals)
    const tokenAAmountRaw = numberOrNull(data.token_a_amount ?? data.amount_a)
    const tokenBAmountRaw = numberOrNull(data.token_b_amount ?? data.amount_b)
    const tokenAAmount = numberOrNull(
      data.token_a_amount_ui ??
      data.token_a_ui_amount ??
      data.token_a_deposit_amount_ui,
    ) ?? (tokenAAmountRaw !== null && tokenADecimals !== null ? tokenAAmountRaw / 10 ** tokenADecimals : null)
    const tokenBAmount = numberOrNull(
      data.token_b_amount_ui ??
      data.token_b_ui_amount ??
      data.token_b_deposit_amount_ui,
    ) ?? (tokenBAmountRaw !== null && tokenBDecimals !== null ? tokenBAmountRaw / 10 ** tokenBDecimals : null)
    const tokenAMint = String(data.token_a_mint ?? data.tokenAMint ?? '')
    const tokenBMint = String(data.token_b_mint ?? data.tokenBMint ?? '')

    return {
      claimableFeesUsd: claimableFeesUsd !== null ? Number(claimableFeesUsd) : null,
      positionValueUsd: positionValueUsd !== null ? Number(positionValueUsd) : null,
      feesClaimedUsd: feesClaimedUsd !== null ? Number(feesClaimedUsd) : null,
      totalFeeEarnedUsd: totalFeeEarnedUsd !== null ? Number(totalFeeEarnedUsd) : null,
      totalPnlUsd: totalPnlUsd !== null ? Number(totalPnlUsd) : null,
      deposits: depositComponents(
        tokenAAmount !== null && tokenAMint ? { mint: tokenAMint, symbol: normalizeSymbolPart(data.token_a_symbol) || tokenAMint.slice(0, 4), amount: tokenAAmount } : null,
        tokenBAmount !== null && tokenBMint ? { mint: tokenBMint, symbol: normalizeSymbolPart(data.token_b_symbol) || tokenBMint.slice(0, 4), amount: tokenBAmount } : null,
      ),
    }
  } catch {
    return null
  }
}

async function estimateDammDeposits(
  positionState: any,
  poolState: any,
  pair: DexPairInfo | null | undefined,
  connection: Connection,
): Promise<TokenDeposit[]> {
  if (!positionState || !poolState) return []

  try {
    const mod = await import('@meteora-ag/cp-amm-sdk')
    const tokenAMint = toBase58(poolState.tokenAMint)
    const tokenBMint = toBase58(poolState.tokenBMint)
    const liquidity = toBn(positionState.unlockedLiquidity)
      .add(toBn(positionState.vestedLiquidity))
      .add(toBn(positionState.permanentLockedLiquidity))

    if (liquidity.isZero()) return []

    const tokenADecimals = await fetchMintDecimals(tokenAMint, connection)
    const tokenBDecimals = await fetchMintDecimals(tokenBMint, connection)
    const amountA = mod.getAmountAFromLiquidityDelta(
      poolState.sqrtPrice,
      poolState.sqrtMaxPrice,
      liquidity,
      mod.Rounding.Up,
      poolState.collectFeeMode,
      poolState.tokenAAmount,
      poolState.liquidity,
    )
    const amountB = mod.getAmountBFromLiquidityDelta(
      poolState.sqrtMinPrice,
      poolState.sqrtPrice,
      liquidity,
      mod.Rounding.Up,
      poolState.collectFeeMode,
      poolState.tokenBAmount,
      poolState.liquidity,
    )

    return depositComponents(
      { mint: tokenAMint, symbol: tokenSymbol(null, tokenAMint, pair), amount: uiAmount(amountA, tokenADecimals) ?? 0 },
      { mint: tokenBMint, symbol: tokenSymbol(null, tokenBMint, pair), amount: uiAmount(amountB, tokenBDecimals) ?? 0 },
    )
  } catch (err) {
    console.warn('[meteora-live] could not estimate DAMM deposits:', err)
    return []
  }
}

async function fetchMeteoraDlmmPositionStats(positionPubkey: string): Promise<Record<string, number | null> | null> {
  if (!positionPubkey) return null
  const cached = getCached(_dlmmPositionStatsCache, positionPubkey)
  if (cached !== undefined) return cached

  try {
    const res = await fetch(`${METEORA_DLMM_POSITION_API}/${positionPubkey}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      setCached(_dlmmPositionStatsCache, positionPubkey, null, DLMM_POSITION_STATS_CACHE_TTL_MS)
      return null
    }
    const data = await res.json()
    const stats = {
      daily_fee_yield: Number(data.daily_fee_yield ?? NaN),
      fee_apr_24h: Number(data.fee_apr_24h ?? NaN),
      fee_apy_24h: Number(data.fee_apy_24h ?? NaN),
      total_fee_usd_claimed: Number(data.total_fee_usd_claimed ?? NaN),
      total_reward_usd_claimed: Number(data.total_reward_usd_claimed ?? NaN),
      position_pnl_usd: Number(data.position_pnl_usd ?? data.pnl_usd ?? data.total_pnl_usd ?? NaN),
      position_pnl_pct: getFirstFiniteRecordNumber(data, PNL_PCT_KEYS) ?? Number.NaN,
    }
    const normalized = Object.fromEntries(
      Object.entries(stats).map(([key, value]) => [key, Number.isFinite(value) ? value : null]),
    ) as Record<string, number | null>
    setCached(_dlmmPositionStatsCache, positionPubkey, normalized, DLMM_POSITION_STATS_CACHE_TTL_MS)
    return normalized
  } catch {
    setCached(_dlmmPositionStatsCache, positionPubkey, null, DLMM_POSITION_STATS_CACHE_TTL_MS)
    return null
  }
}

async function fetchMeteoraDammPoolStats(poolAddress: string): Promise<{
  volume24hUsd: number | null
  tvlUsd: number | null
} | null> {
  try {
    const res = await fetch(`https://amm-v2.meteora.ag/pool/${poolAddress}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    return {
      volume24hUsd: Number(data.trading_volume ?? data.volume_24h ?? 0) || null,
      tvlUsd: Number(data.pool_tvl ?? data.tvl ?? 0) || null,
    }
  } catch {
    return null
  }
}

export interface LiveDlmmPosition {
  id: string
  mint: string
  symbol: string
  pool_address: string
  position_pubkey: string
  strategy_id: string
  position_type: string
  status: 'active' | 'out_of_range'
  in_range: boolean
  opened_at: string
  sol_deposited: number
  token_amount: number
  entry_price: number
  entry_price_sol: number
  entry_price_usd: number
  current_price: number
  claimable_fees_usd?: number | null
  position_value_usd?: number | null
  pnl_usd?: number | null
  pnl_pct?: number | null
  deposits?: TokenDeposit[]
  dry_run: boolean
  metadata: Record<string, unknown>
  _source: 'meteora-live'
}

export interface LiveDammPosition extends Omit<LiveDlmmPosition, 'position_type' | 'strategy_id' | 'status'> {
  strategy_id: 'damm-live'
  position_type: 'damm-edge'
  status: 'active'
}

export type LiveMeteoraPosition = LiveDlmmPosition | LiveDammPosition

export interface LiveMeteoraSnapshot {
  positions: LiveMeteoraPosition[]
  dlmmOk: boolean
  dammOk: boolean
  dlmmError?: string | null
  dammError?: string | null
}

export interface MeteoraLiveSourceStatus {
  dlmmOk: boolean
  dammOk: boolean
}

export async function fetchLiveDlmmPositions(connection: Connection = getConnection()): Promise<LiveDlmmPosition[]> {
  const walletPublicKey = getWalletPublicKey()
  const DLMM = await getDLMM()

  const allPositions: Map<string, any> = await DLMM.getAllLbPairPositionsByUser(
    connection,
    walletPublicKey,
  )

  const live: LiveDlmmPosition[] = []

  for (const [mapPoolAddress, positionInfo] of allPositions) {
    const poolAddress = toBase58(positionInfo?.publicKey) || mapPoolAddress
    const positions = extractPositions(positionInfo)
    if (positions.length === 0) continue

    const mint = resolveMint(positionInfo) || poolAddress
    const resolved = await resolveLiveSymbol(mint, poolAddress, 'LIVE', positionInfo)
    let activeBinId: number | null = null
    let currentPrice = 0

    try {
      const dlmmPool = await DLMM.create(connection, new PublicKey(poolAddress))
      const activeBin = await dlmmPool.getActiveBin()
      activeBinId = Number(activeBin.binId)
      currentPrice = Number(activeBin.pricePerToken) || 0
    } catch (err) {
      console.warn(`[meteora-live] could not fetch active bin for ${poolAddress}:`, err)
    }

    for (const pos of positions) {
      const positionPubkey = toBase58(pos.publicKey)
      if (!positionPubkey) continue

      const positionData = pos.positionData ?? {}
      const positionStats = await fetchMeteoraDlmmPositionStats(positionPubkey)
      const usdFields = estimateDlmmUsdFields(positionData, positionInfo, resolved.pair)
      const solDeposited = estimateSolDeposited(positionData, positionInfo)
      const positionPnlUsd = positionStats?.position_pnl_usd ?? deriveLiveDlmmPnlUsd(solDeposited, usdFields)
      const positionPnlPct = positionStats?.position_pnl_pct ?? deriveOpenPnlPct(
        positionPnlUsd,
        solDeposited,
        usdFields,
      )
      const lowerBinId = Number(positionData.lowerBinId ?? 0)
      const upperBinId = Number(positionData.upperBinId ?? 0)
      const inRange = activeBinId !== null
        ? activeBinId >= lowerBinId && activeBinId <= upperBinId
        : true

      live.push({
        id: `meteora-${positionPubkey}`,
        mint,
        symbol: resolved.symbol,
        pool_address: poolAddress,
        position_pubkey: positionPubkey,
        strategy_id: 'meteora-live',
        position_type: 'dlmm',
        status: inRange ? 'active' : 'out_of_range',
        in_range: inRange,
        opened_at: openedAtFromPosition(positionData),
        sol_deposited: solDeposited,
        token_amount: 0,
        entry_price: 0,
        entry_price_sol: 0,
        entry_price_usd: 0,
        current_price: currentPrice,
        claimable_fees_usd: usdFields.claimableFeesUsd,
        position_value_usd: usdFields.positionValueUsd,
        pnl_usd: positionPnlUsd,
        pnl_pct: positionPnlPct,
        deposits: usdFields.deposits,
        dry_run: false,
        metadata: {
          source_of_truth: 'meteora',
          detected_by: 'wallet-position-scan',
          token_x_mint: toBase58(positionInfo?.tokenX?.publicKey),
          token_y_mint: toBase58(positionInfo?.tokenY?.publicKey),
          token_x_symbol: normalizeSymbolPart(positionInfo?.tokenX?.symbol),
          token_y_symbol: normalizeSymbolPart(positionInfo?.tokenY?.symbol),
          token_x_decimals: tokenDecimals(positionInfo?.tokenX, toBase58(positionInfo?.tokenX?.publicKey)),
          token_y_decimals: tokenDecimals(positionInfo?.tokenY, toBase58(positionInfo?.tokenY?.publicKey)),
          dex_pair_address: resolved.pair?.pairAddress ?? null,
          dex_price_usd: resolved.pair?.priceUsd != null ? Number(resolved.pair.priceUsd) : null,
          dex_liquidity_usd: resolved.pair?.liquidity?.usd ?? null,
          volume_24h_usd: resolved.pair?.volume?.h24 ?? null,
          bin_step: positionInfo?.binStep ?? positionInfo?.lbPair?.binStep ?? null,
          base_fee_pct: positionInfo?.baseFeePercentage ?? positionInfo?.lbPair?.baseFeePercentage ?? null,
          lower_bin_id: lowerBinId,
          upper_bin_id: upperBinId,
          active_bin_id: activeBinId,
          total_x_amount: String(positionData.totalXAmount ?? '0'),
          total_y_amount: String(positionData.totalYAmount ?? '0'),
          fee_x_amount: String(positionData.feeX ?? '0'),
          fee_y_amount: String(positionData.feeY ?? '0'),
          deposits: usdFields.deposits,
          sol_price_usd: usdFields.solPriceUsd,
          ...(usdFields.claimableFeesUsd !== null && { claimable_fees_usd: usdFields.claimableFeesUsd }),
          ...(usdFields.positionValueUsd !== null && { position_value_usd: usdFields.positionValueUsd }),
          ...(positionStats?.daily_fee_yield !== null && positionStats?.daily_fee_yield !== undefined && { daily_fee_yield: positionStats.daily_fee_yield }),
          ...(positionStats?.fee_apr_24h !== null && positionStats?.fee_apr_24h !== undefined && { fee_apr_24h: positionStats.fee_apr_24h }),
          ...(positionStats?.fee_apy_24h !== null && positionStats?.fee_apy_24h !== undefined && { fee_apy_24h: positionStats.fee_apy_24h }),
          ...(positionStats?.total_fee_usd_claimed !== null && positionStats?.total_fee_usd_claimed !== undefined && { total_fee_usd_claimed: positionStats.total_fee_usd_claimed }),
          ...(positionStats?.total_reward_usd_claimed !== null && positionStats?.total_reward_usd_claimed !== undefined && { total_reward_usd_claimed: positionStats.total_reward_usd_claimed }),
          ...(positionPnlUsd !== null && positionPnlUsd !== undefined && { position_pnl_usd: positionPnlUsd }),
          ...(positionPnlUsd !== null && positionPnlUsd !== undefined && { pnl_usd: positionPnlUsd }),
          ...(positionPnlPct !== null && positionPnlPct !== undefined && { position_pnl_pct: positionPnlPct }),
          ...(positionPnlPct !== null && positionPnlPct !== undefined && { pnl_pct: positionPnlPct }),
          ...(resolved.dexUrl && { dexscreener_url: resolved.dexUrl }),
          version: pos.version ?? null,
          synced_at: new Date().toISOString(),
        },
        _source: 'meteora-live',
      })
    }
  }

  return live
}

export async function fetchLiveDammPositions(connection: Connection = getConnection()): Promise<LiveDammPosition[]> {
  const walletPublicKey = getWalletPublicKey()
  const sdk = await getCpAmm(connection)

  const userPositions: Array<{
    positionNftAccount: PublicKey
    position: PublicKey
    positionState: any
  }> = await sdk.getPositionsByUser(walletPublicKey)

  const live: LiveDammPosition[] = []

  for (const item of userPositions) {
    const positionPubkey = toBase58(item.position)
    if (!positionPubkey) continue

    const positionState = item.positionState ?? {}
    const poolAddress = toBase58(positionState.pool)
    if (!poolAddress) continue

    let poolState: any | null = null
    try {
      poolState = await sdk.fetchPoolState(new PublicKey(poolAddress))
    } catch (err) {
      console.warn(`[meteora-live] could not fetch DAMM pool for ${positionPubkey}:`, err)
    }

    const meteoraFields = await fetchMeteoraDammPositionFields(positionPubkey)
    const mint = resolveDammMint(poolState) || poolAddress
    const resolved = await resolveLiveSymbol(mint, poolAddress, 'DAMM')
    const poolStats = await fetchMeteoraDammPoolStats(poolAddress)
    const dammPrice = poolState ? await getDammSolPriceFromPoolState(connection, poolState) : null
    const currentPrice = dammPrice?.solPerToken ?? 0
    const tokenAMint = toBase58(poolState?.tokenAMint)
    const tokenBMint = toBase58(poolState?.tokenBMint)
    const tokenPrices = inferUsdPrices(resolved.pair, tokenAMint, tokenBMint)
    const sdkDeposits = await estimateDammDeposits(positionState, poolState, resolved.pair, connection)
    const claimableFeesUsd = meteoraFields?.claimableFeesUsd ?? null
    const positionValueUsd = meteoraFields?.positionValueUsd ?? null
    const feesClaimedUsd = meteoraFields?.feesClaimedUsd ?? null
    const totalFeeEarnedUsd = meteoraFields?.totalFeeEarnedUsd ?? null
    const totalPnlUsd = meteoraFields?.totalPnlUsd ?? null
    const deposits = meteoraFields?.deposits?.length ? meteoraFields.deposits : sdkDeposits

    live.push({
      id: `meteora-damm-${positionPubkey}`,
      mint,
      symbol: resolved.symbol,
      pool_address: poolAddress,
      position_pubkey: positionPubkey,
      strategy_id: 'damm-live',
      position_type: 'damm-edge',
      status: 'active',
      in_range: true,
      opened_at: new Date().toISOString(),
      sol_deposited: 0,
      token_amount: 0,
      entry_price: 0,
      entry_price_sol: 0,
      entry_price_usd: 0,
      current_price: currentPrice,
      claimable_fees_usd: claimableFeesUsd,
      position_value_usd: positionValueUsd,
      pnl_usd: totalPnlUsd,
      deposits,
      dry_run: false,
      metadata: {
        source_of_truth: 'meteora',
        detected_by: 'wallet-position-scan',
        position_kind: 'damm-v2',
        position_nft_account: toBase58(item.positionNftAccount),
        nft_mint: toBase58(positionState.nftMint),
        token_a_mint: tokenAMint,
        token_b_mint: tokenBMint,
        ...(dammPrice && {
          current_price_basis: 'sol_per_token',
          raw_pool_price: dammPrice.poolPrice,
          token_a_decimals: dammPrice.tokenADecimals,
          token_b_decimals: dammPrice.tokenBDecimals,
        }),
        dex_pair_address: resolved.pair?.pairAddress ?? null,
        dex_price_usd: resolved.pair?.priceUsd != null ? Number(resolved.pair.priceUsd) : null,
        dex_liquidity_usd: resolved.pair?.liquidity?.usd ?? null,
        tvl_usd: poolStats?.tvlUsd ?? resolved.pair?.liquidity?.usd ?? null,
        volume_24h_usd: poolStats?.volume24hUsd ?? resolved.pair?.volume?.h24 ?? null,
        pool_type: poolState?.poolType ?? null,
        fee_version: poolState?.feeVersion ?? null,
        collect_fee_mode: poolState?.collectFeeMode ?? null,
        fee_a_pending: String(positionState.feeAPending ?? '0'),
        fee_b_pending: String(positionState.feeBPending ?? '0'),
        unlocked_liquidity: String(positionState.unlockedLiquidity ?? '0'),
        vested_liquidity: String(positionState.vestedLiquidity ?? '0'),
        permanent_locked_liquidity: String(positionState.permanentLockedLiquidity ?? '0'),
        deposits,
        sol_price_usd: solUsdPrice(tokenAMint, tokenBMint, tokenPrices.tokenXUsd, tokenPrices.tokenYUsd),
        ...(claimableFeesUsd !== null && { claimable_fees_usd: claimableFeesUsd }),
        ...(positionValueUsd !== null && { position_value_usd: positionValueUsd }),
        ...(feesClaimedUsd !== null && { total_fee_usd_claimed: feesClaimedUsd }),
        ...(totalFeeEarnedUsd !== null && { total_fee_earned_usd: totalFeeEarnedUsd }),
        ...(totalPnlUsd !== null && { pnl_usd: totalPnlUsd }),
        ...(totalPnlUsd !== null && { total_pnl_usd: totalPnlUsd }),
        ...(resolved.dexUrl && { dexscreener_url: resolved.dexUrl }),
        synced_at: new Date().toISOString(),
      },
      _source: 'meteora-live',
    })
  }

  return live
}

async function fetchLiveMeteoraSnapshotForConnection(connection: Connection): Promise<LiveMeteoraSnapshot> {
  const [dlmm, damm] = await Promise.allSettled([
    fetchLiveDlmmPositions(connection),
    fetchLiveDammPositions(connection),
  ])

  if (dlmm.status === 'rejected') {
    console.warn('[meteora-live] DLMM live fetch failed:', dlmm.reason)
  }
  if (damm.status === 'rejected') {
    console.warn('[meteora-live] DAMM live fetch failed:', damm.reason)
  }

  return {
    positions: [
    ...(dlmm.status === 'fulfilled' ? dlmm.value : []),
    ...(damm.status === 'fulfilled' ? damm.value : []),
    ],
    dlmmOk: dlmm.status === 'fulfilled',
    dammOk: damm.status === 'fulfilled',
    dlmmError: dlmm.status === 'rejected' ? errorMessage(dlmm.reason) : null,
    dammError: damm.status === 'rejected' ? errorMessage(damm.reason) : null,
  }
}

export async function fetchLiveMeteoraSnapshot(): Promise<LiveMeteoraSnapshot> {
  const endpoints = getRpcEndpointCandidates({ includePublicFallback: true })
  if (endpoints.length === 0) {
    return fetchLiveMeteoraSnapshotForConnection(getConnection())
  }

  let dlmmPositions: LiveDlmmPosition[] | null = null
  let dammPositions: LiveDammPosition[] | null = null
  let dlmmError: string | null = null
  let dammError: string | null = null

  for (let i = 0; i < endpoints.length; i++) {
    const snapshot = await fetchLiveMeteoraSnapshotForConnection(createConnection(endpoints[i]))
    if (snapshot.dlmmOk && dlmmPositions === null) {
      dlmmPositions = snapshot.positions.filter((position): position is LiveDlmmPosition => position.position_type === 'dlmm')
    } else if (!snapshot.dlmmOk) {
      dlmmError = snapshot.dlmmError ?? null
    }

    if (snapshot.dammOk && dammPositions === null) {
      dammPositions = snapshot.positions.filter((position): position is LiveDammPosition => position.position_type === 'damm-edge')
    } else if (!snapshot.dammOk) {
      dammError = snapshot.dammError ?? null
    }

    if (dlmmPositions !== null && dammPositions !== null) break

    if ((!snapshot.dlmmOk || !snapshot.dammOk) && i < endpoints.length - 1) {
      console.warn(
        `[meteora-live] live fetch incomplete on RPC endpoint ${i + 1}/${endpoints.length}; trying fallback ` +
        `(dlmm=${snapshot.dlmmOk ? 'ok' : 'failed'}, damm=${snapshot.dammOk ? 'ok' : 'failed'})`,
      )
    }
  }

  return {
    positions: [
      ...(dlmmPositions ?? []),
      ...(dammPositions ?? []),
    ],
    dlmmOk: dlmmPositions !== null,
    dammOk: dammPositions !== null,
    dlmmError: dlmmPositions !== null ? null : dlmmError,
    dammError: dammPositions !== null ? null : dammError,
  }
}

export async function fetchLiveMeteoraPositions(): Promise<LiveMeteoraPosition[]> {
  const snapshot = await fetchLiveMeteoraSnapshot()
  if (!snapshot.dlmmOk && !snapshot.dammOk) {
    throw new Error(
      `Meteora live fetch failed for DLMM and DAMM` +
      `${snapshot.dlmmError ? `; DLMM: ${snapshot.dlmmError}` : ''}` +
      `${snapshot.dammError ? `; DAMM: ${snapshot.dammError}` : ''}`,
    )
  }
  return snapshot.positions
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = numberOrNull(value)
    if (n !== null) return n
  }
  return null
}

function closedRecently(closedAt: unknown): boolean {
  const timestamp = Date.parse(String(closedAt ?? ''))
  return Number.isFinite(timestamp) && Date.now() - timestamp < CLOSED_LIVE_REOPEN_GRACE_MS
}

function mergeStatus(row: Record<string, unknown>, liveStatus: string): string {
  const status = String(row.status ?? '')
  if (status === 'pending_close') return status
  if (status === 'closed' && closedRecently(row.closed_at)) return status
  return liveStatus
}

function deriveOpenPnlUsd(
  positionValueUsd: number | null,
  claimableFeesUsd: number | null,
  solDeposited: number,
  metadata: Record<string, unknown>,
  entryPriceUsd: number | null,
  entryPriceSol: number | null,
): number | null {
  if (positionValueUsd === null || solDeposited <= 0) return null

  const entrySolPriceUsd = entryPriceUsd !== null && entryPriceSol !== null && entryPriceUsd > 0 && entryPriceSol > 0
    ? entryPriceUsd / entryPriceSol
    : null
  const solPriceUsd = firstFiniteNumber(metadata.sol_price_usd, metadata.current_sol_price_usd, metadata.entry_sol_price_usd, entrySolPriceUsd)
  if (solPriceUsd === null || solPriceUsd <= 0) return null

  const manualAddSol = firstFiniteNumber(metadata.manual_add_sol_total) ?? 0
  const manualAddCostUsd = firstFiniteNumber(metadata.manual_add_cost_usd, metadata.manual_add_estimated_cost_usd)
  const originalSolDeposited = manualAddCostUsd !== null
    ? Math.max(0, solDeposited - manualAddSol)
    : solDeposited
  const costBasisUsd = originalSolDeposited * solPriceUsd + (manualAddCostUsd ?? 0)

  const claimedUsd =
    (firstFiniteNumber(metadata.total_fee_usd_claimed) ?? 0) +
    (firstFiniteNumber(metadata.total_reward_usd_claimed) ?? 0) +
    (firstFiniteNumber(metadata.fees_claimed_usd) ?? 0)

  return roundMoney(
    positionValueUsd +
    (claimableFeesUsd ?? 0) +
    claimedUsd -
    costBasisUsd,
  )
}

export function mergeDbAndLiveLpPositions(
  dbRows: any[],
  liveRows: LiveMeteoraPosition[],
  options: { liveFetchOk?: boolean; includeDbClosed?: boolean; dlmmOk?: boolean; dammOk?: boolean } = {},
): any[] {
  const liveFetchOk = options.liveFetchOk ?? liveRows.length > 0
  const sourceOk = {
    dlmmOk: options.dlmmOk ?? liveFetchOk,
    dammOk: options.dammOk ?? liveFetchOk,
  }
  if (!sourceOk.dlmmOk && !sourceOk.dammOk && liveRows.length === 0) return dbRows

  const liveByPubkey = new Map(liveRows.map(row => [row.position_pubkey, row]))
  const merged: any[] = []
  const seen = new Set<string>()

  for (const row of dbRows) {
    const live = liveByPubkey.get(row.position_pubkey)
    const keepDbOnly = row.dry_run === true || row.status === 'pending_retry' || (options.includeDbClosed === true && row.status === 'closed')
    const rowSourceOk = isDammLike(row) ? sourceOk.dammOk : sourceOk.dlmmOk
    if (!live && !keepDbOnly && rowSourceOk) continue

    if (live) {
      seen.add(live.position_pubkey)
      const dbSymbol = String(row.symbol ?? '')
      const symbol = /^(LIVE|DAMM|ORPHAN)-/.test(dbSymbol) || dbSymbol === 'SOL'
        ? live.symbol
        : (row.symbol ?? live.symbol)
      const metadata = {
        ...(row.metadata ?? {}),
        ...(live.metadata ?? {}),
      }
      const solDeposited = Number(row.sol_deposited ?? 0) > 0 ? row.sol_deposited : live.sol_deposited
      const claimableFeesUsd = live.claimable_fees_usd ?? row.claimable_fees_usd
      const positionValueUsd = live.position_value_usd ?? row.position_value_usd
      const pnlUsd = firstFiniteNumber(
        live.pnl_usd,
        row.pnl_usd,
        row.realized_pnl_usd,
        metadata.pnl_usd,
        metadata.total_pnl_usd,
        metadata.position_pnl_usd,
        metadata.realized_pnl_usd,
      ) ?? deriveOpenPnlUsd(
        firstFiniteNumber(positionValueUsd),
        firstFiniteNumber(claimableFeesUsd),
        Number(solDeposited ?? 0),
        metadata,
        firstFiniteNumber(row.entry_price_usd, live.entry_price_usd),
        firstFiniteNumber(row.entry_price_sol, live.entry_price_sol),
      )
      const pnlPct = firstFiniteNumber(
        live.pnl_pct,
        row.pnl_pct,
        metadata.pnl_pct,
        metadata.position_pnl_pct,
        metadata.position_pnl_percentage,
        metadata.pnl_percentage,
      )
      merged.push({
        ...row,
        ...live,
        id: row.id ?? live.id,
        symbol,
        strategy_id: row.strategy_id ?? live.strategy_id,
        opened_at: row.opened_at ?? live.opened_at,
        sol_deposited: solDeposited,
        entry_price: row.entry_price ?? live.entry_price,
        entry_price_sol: row.entry_price_sol ?? live.entry_price_sol,
        entry_price_usd: row.entry_price_usd ?? live.entry_price_usd,
        tx_open: row.tx_open,
        status: mergeStatus(row, live.status),
        in_range: live.in_range,
        current_price: live.current_price || row.current_price,
        claimable_fees_usd: claimableFeesUsd,
        position_value_usd: positionValueUsd,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        deposits: live.deposits ?? row.deposits ?? metadata.deposits,
        metadata: {
          ...metadata,
          ...(pnlUsd !== null && { pnl_usd: pnlUsd }),
          ...(pnlPct !== null && { pnl_pct: pnlPct, position_pnl_pct: pnlPct }),
        },
        _source: 'meteora-live+supabase',
      })
    } else {
      merged.push(row)
    }
  }

  for (const live of liveRows) {
    if (!seen.has(live.position_pubkey)) merged.push(live)
  }

  return merged
}

function isDammLike(row: { strategy_id?: string | null; position_type?: string | null }): boolean {
  return (
    row.strategy_id === 'pre_grad' ||
    row.strategy_id === 'pre-grad' ||
    row.strategy_id === 'damm-edge' ||
    row.strategy_id === 'damm-live' ||
    row.strategy_id === 'damm-migration' ||
    row.strategy_id === 'damm-launch' ||
    row.position_type === 'pre_grad' ||
    row.position_type === 'pre-grad' ||
    row.position_type === 'damm-edge' ||
    row.position_type === 'damm-migration' ||
    row.position_type === 'damm-launch'
  )
}
