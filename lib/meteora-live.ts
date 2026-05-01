import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'

const SOL_MINT = 'So11111111111111111111111111111111111111112'
const DEXSCREENER_SOLANA_PAIR_API = 'https://api.dexscreener.com/latest/dex/pairs/solana'
const DEXSCREENER_TOKEN_API = 'https://api.dexscreener.com/latest/dex/tokens'
const METEORA_DLMM_POSITION_API = 'https://dlmm-api.meteora.ag/position'
const _pairInfoCache = new Map<string, DexPairInfo | null>()
const _dlmmPositionStatsCache = new Map<string, Record<string, number | null> | null>()

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
}

async function getCpAmm(): Promise<any> {
  const { CpAmm } = await import('@meteora-ag/cp-amm-sdk')
  return new CpAmm(getConnection())
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

async function fetchDexPairByPool(poolAddress: string): Promise<DexPairInfo | null> {
  if (!poolAddress) return null
  const cacheKey = `pool:${poolAddress}`
  if (_pairInfoCache.has(cacheKey)) return _pairInfoCache.get(cacheKey) ?? null

  const data = await fetchDexJson(`${DEXSCREENER_SOLANA_PAIR_API}/${poolAddress}`)
  const pair = (data?.pair ?? data?.pairs?.[0] ?? null) as DexPairInfo | null
  _pairInfoCache.set(cacheKey, pair)
  return pair
}

async function fetchDexPairByToken(mint: string, poolAddress?: string): Promise<DexPairInfo | null> {
  if (!mint) return null
  const cacheKey = `token:${mint}:${poolAddress ?? ''}`
  if (_pairInfoCache.has(cacheKey)) return _pairInfoCache.get(cacheKey) ?? null

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
  _pairInfoCache.set(cacheKey, pair)
  return pair
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

function tokenDecimals(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function uiAmount(raw: unknown, decimals: number): number {
  const amount = toNumber(raw)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  return amount / 10 ** decimals
}

function roundUsd(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 100) / 100
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
} {
  const tokenXMint = toBase58(positionInfo?.tokenX?.publicKey)
  const tokenYMint = toBase58(positionInfo?.tokenY?.publicKey)
  const tokenXDecimals = tokenDecimals(positionInfo?.tokenX?.decimals)
  const tokenYDecimals = tokenDecimals(positionInfo?.tokenY?.decimals)
  const { tokenXUsd, tokenYUsd } = inferUsdPrices(pair, tokenXMint, tokenYMint)

  const feeX = uiAmount(positionData?.feeX, tokenXDecimals)
  const feeY = uiAmount(positionData?.feeY, tokenYDecimals)
  const totalX = uiAmount(positionData?.totalXAmount, tokenXDecimals)
  const totalY = uiAmount(positionData?.totalYAmount, tokenYDecimals)

  const claimableFeesUsd = roundUsd(
    (tokenXUsd !== null ? feeX * tokenXUsd : 0) +
    (tokenYUsd !== null ? feeY * tokenYUsd : 0),
  )
  const positionValueUsd = roundUsd(
    (tokenXUsd !== null ? totalX * tokenXUsd : 0) +
    (tokenYUsd !== null ? totalY * tokenYUsd : 0),
  )

  return { claimableFeesUsd, positionValueUsd }
}

function openedAtFromPosition(positionData: any): string {
  const ts = toNumber(positionData?.lastUpdatedAt)
  if (ts > 0) return new Date(ts * 1000).toISOString()
  return new Date().toISOString()
}

function sqrtPriceToNumber(sqrtPrice: unknown): number {
  const raw = Number(
    typeof (sqrtPrice as { toString?: unknown })?.toString === 'function'
      ? (sqrtPrice as { toString: () => string }).toString()
      : sqrtPrice,
  )
  if (!Number.isFinite(raw) || raw <= 0) return 0
  const ratio = raw / 2 ** 64
  return ratio * ratio
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

    return {
      claimableFeesUsd: claimableFeesUsd !== null ? Number(claimableFeesUsd) : null,
      positionValueUsd: positionValueUsd !== null ? Number(positionValueUsd) : null,
      feesClaimedUsd: feesClaimedUsd !== null ? Number(feesClaimedUsd) : null,
      totalFeeEarnedUsd: totalFeeEarnedUsd !== null ? Number(totalFeeEarnedUsd) : null,
      totalPnlUsd: totalPnlUsd !== null ? Number(totalPnlUsd) : null,
    }
  } catch {
    return null
  }
}

async function fetchMeteoraDlmmPositionStats(positionPubkey: string): Promise<Record<string, number | null> | null> {
  if (!positionPubkey) return null
  if (_dlmmPositionStatsCache.has(positionPubkey)) return _dlmmPositionStatsCache.get(positionPubkey) ?? null

  try {
    const res = await fetch(`${METEORA_DLMM_POSITION_API}/${positionPubkey}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      _dlmmPositionStatsCache.set(positionPubkey, null)
      return null
    }
    const data = await res.json()
    const stats = {
      daily_fee_yield: Number(data.daily_fee_yield ?? NaN),
      fee_apr_24h: Number(data.fee_apr_24h ?? NaN),
      fee_apy_24h: Number(data.fee_apy_24h ?? NaN),
      total_fee_usd_claimed: Number(data.total_fee_usd_claimed ?? NaN),
      total_reward_usd_claimed: Number(data.total_reward_usd_claimed ?? NaN),
    }
    const normalized = Object.fromEntries(
      Object.entries(stats).map(([key, value]) => [key, Number.isFinite(value) ? value : null]),
    ) as Record<string, number | null>
    _dlmmPositionStatsCache.set(positionPubkey, normalized)
    return normalized
  } catch {
    _dlmmPositionStatsCache.set(positionPubkey, null)
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
}

export async function fetchLiveDlmmPositions(): Promise<LiveDlmmPosition[]> {
  const connection = getConnection()
  const wallet = getWallet()
  const DLMM = await getDLMM()

  const allPositions: Map<string, any> = await DLMM.getAllLbPairPositionsByUser(
    connection,
    wallet.publicKey,
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
        sol_deposited: estimateSolDeposited(positionData, positionInfo),
        token_amount: 0,
        entry_price: 0,
        entry_price_sol: 0,
        entry_price_usd: 0,
        current_price: currentPrice,
        claimable_fees_usd: usdFields.claimableFeesUsd,
        position_value_usd: usdFields.positionValueUsd,
        dry_run: false,
        metadata: {
          source_of_truth: 'meteora',
          detected_by: 'wallet-position-scan',
          token_x_mint: toBase58(positionInfo?.tokenX?.publicKey),
          token_y_mint: toBase58(positionInfo?.tokenY?.publicKey),
          token_x_symbol: normalizeSymbolPart(positionInfo?.tokenX?.symbol),
          token_y_symbol: normalizeSymbolPart(positionInfo?.tokenY?.symbol),
          token_x_decimals: tokenDecimals(positionInfo?.tokenX?.decimals),
          token_y_decimals: tokenDecimals(positionInfo?.tokenY?.decimals),
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
          ...(usdFields.claimableFeesUsd !== null && { claimable_fees_usd: usdFields.claimableFeesUsd }),
          ...(usdFields.positionValueUsd !== null && { position_value_usd: usdFields.positionValueUsd }),
          ...(positionStats?.daily_fee_yield !== null && positionStats?.daily_fee_yield !== undefined && { daily_fee_yield: positionStats.daily_fee_yield }),
          ...(positionStats?.fee_apr_24h !== null && positionStats?.fee_apr_24h !== undefined && { fee_apr_24h: positionStats.fee_apr_24h }),
          ...(positionStats?.fee_apy_24h !== null && positionStats?.fee_apy_24h !== undefined && { fee_apy_24h: positionStats.fee_apy_24h }),
          ...(positionStats?.total_fee_usd_claimed !== null && positionStats?.total_fee_usd_claimed !== undefined && { total_fee_usd_claimed: positionStats.total_fee_usd_claimed }),
          ...(positionStats?.total_reward_usd_claimed !== null && positionStats?.total_reward_usd_claimed !== undefined && { total_reward_usd_claimed: positionStats.total_reward_usd_claimed }),
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

export async function fetchLiveDammPositions(): Promise<LiveDammPosition[]> {
  const wallet = getWallet()
  const sdk = await getCpAmm()

  const userPositions: Array<{
    positionNftAccount: PublicKey
    position: PublicKey
    positionState: any
  }> = await sdk.getPositionsByUser(wallet.publicKey)

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
    const currentPrice = poolState ? sqrtPriceToNumber(poolState.sqrtPrice) : 0
    const claimableFeesUsd = meteoraFields?.claimableFeesUsd ?? null
    const positionValueUsd = meteoraFields?.positionValueUsd ?? null
    const feesClaimedUsd = meteoraFields?.feesClaimedUsd ?? null
    const totalFeeEarnedUsd = meteoraFields?.totalFeeEarnedUsd ?? null
    const totalPnlUsd = meteoraFields?.totalPnlUsd ?? null

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
      dry_run: false,
      metadata: {
        source_of_truth: 'meteora',
        detected_by: 'wallet-position-scan',
        position_kind: 'damm-v2',
        position_nft_account: toBase58(item.positionNftAccount),
        nft_mint: toBase58(positionState.nftMint),
        token_a_mint: toBase58(poolState?.tokenAMint),
        token_b_mint: toBase58(poolState?.tokenBMint),
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
        ...(claimableFeesUsd !== null && { claimable_fees_usd: claimableFeesUsd }),
        ...(positionValueUsd !== null && { position_value_usd: positionValueUsd }),
        ...(feesClaimedUsd !== null && { total_fee_usd_claimed: feesClaimedUsd }),
        ...(totalFeeEarnedUsd !== null && { total_fee_earned_usd: totalFeeEarnedUsd }),
        ...(totalPnlUsd !== null && { total_pnl_usd: totalPnlUsd }),
        ...(resolved.dexUrl && { dexscreener_url: resolved.dexUrl }),
        synced_at: new Date().toISOString(),
      },
      _source: 'meteora-live',
    })
  }

  return live
}

export async function fetchLiveMeteoraSnapshot(): Promise<LiveMeteoraSnapshot> {
  const [dlmm, damm] = await Promise.allSettled([
    fetchLiveDlmmPositions(),
    fetchLiveDammPositions(),
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
  }
}

export async function fetchLiveMeteoraPositions(): Promise<LiveMeteoraPosition[]> {
  return (await fetchLiveMeteoraSnapshot()).positions
}

export function mergeDbAndLiveLpPositions(
  dbRows: any[],
  liveRows: LiveMeteoraPosition[],
  options: { liveFetchOk?: boolean; includeDbClosed?: boolean } = {},
): any[] {
  const liveFetchOk = options.liveFetchOk ?? liveRows.length > 0
  if (!liveFetchOk && liveRows.length === 0) return dbRows

  const liveByPubkey = new Map(liveRows.map(row => [row.position_pubkey, row]))
  const merged: any[] = []
  const seen = new Set<string>()

  for (const row of dbRows) {
    const live = liveByPubkey.get(row.position_pubkey)
    const keepDbOnly = row.dry_run === true || row.status === 'pending_retry' || (options.includeDbClosed === true && row.status === 'closed')
    if (!live && !keepDbOnly) continue

    if (live) {
      seen.add(live.position_pubkey)
      const dbSymbol = String(row.symbol ?? '')
      const symbol = /^(LIVE|DAMM|ORPHAN)-/.test(dbSymbol) || dbSymbol === 'SOL'
        ? live.symbol
        : (row.symbol ?? live.symbol)
      merged.push({
        ...row,
        ...live,
        id: row.id ?? live.id,
        symbol,
        strategy_id: row.strategy_id ?? live.strategy_id,
        opened_at: row.opened_at ?? live.opened_at,
        sol_deposited: Number(row.sol_deposited ?? 0) > 0 ? row.sol_deposited : live.sol_deposited,
        entry_price: row.entry_price ?? live.entry_price,
        entry_price_sol: row.entry_price_sol ?? live.entry_price_sol,
        entry_price_usd: row.entry_price_usd ?? live.entry_price_usd,
        tx_open: row.tx_open,
        status: live.status,
        in_range: live.in_range,
        current_price: live.current_price || row.current_price,
        claimable_fees_usd: live.claimable_fees_usd ?? row.claimable_fees_usd,
        position_value_usd: live.position_value_usd ?? row.position_value_usd,
        metadata: {
          ...(row.metadata ?? {}),
          ...(live.metadata ?? {}),
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
