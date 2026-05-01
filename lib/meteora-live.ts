import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

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
    return (value as { toNumber: () => number }).toNumber()
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

    return {
      claimableFeesUsd: claimableFeesUsd !== null ? Number(claimableFeesUsd) : null,
      positionValueUsd: positionValueUsd !== null ? Number(positionValueUsd) : null,
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
      const lowerBinId = Number(positionData.lowerBinId ?? 0)
      const upperBinId = Number(positionData.upperBinId ?? 0)
      const inRange = activeBinId !== null
        ? activeBinId >= lowerBinId && activeBinId <= upperBinId
        : true

      live.push({
        id: `meteora-${positionPubkey}`,
        mint,
        symbol: `LIVE-${mint.slice(0, 6)}`,
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
        dry_run: false,
        metadata: {
          source_of_truth: 'meteora',
          detected_by: 'wallet-position-scan',
          lower_bin_id: lowerBinId,
          upper_bin_id: upperBinId,
          active_bin_id: activeBinId,
          total_x_amount: String(positionData.totalXAmount ?? '0'),
          total_y_amount: String(positionData.totalYAmount ?? '0'),
          fee_x_amount: String(positionData.feeX ?? '0'),
          fee_y_amount: String(positionData.feeY ?? '0'),
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
    const currentPrice = poolState ? sqrtPriceToNumber(poolState.sqrtPrice) : 0
    const claimableFeesUsd = meteoraFields?.claimableFeesUsd ?? null
    const positionValueUsd = meteoraFields?.positionValueUsd ?? null

    live.push({
      id: `meteora-damm-${positionPubkey}`,
      mint,
      symbol: `DAMM-${mint.slice(0, 6)}`,
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
        fee_a_pending: String(positionState.feeAPending ?? '0'),
        fee_b_pending: String(positionState.feeBPending ?? '0'),
        unlocked_liquidity: String(positionState.unlockedLiquidity ?? '0'),
        vested_liquidity: String(positionState.vestedLiquidity ?? '0'),
        permanent_locked_liquidity: String(positionState.permanentLockedLiquidity ?? '0'),
        ...(claimableFeesUsd !== null && { claimable_fees_usd: claimableFeesUsd }),
        ...(positionValueUsd !== null && { position_value_usd: positionValueUsd }),
        synced_at: new Date().toISOString(),
      },
      _source: 'meteora-live',
    })
  }

  return live
}

export async function fetchLiveMeteoraPositions(): Promise<LiveMeteoraPosition[]> {
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

  return [
    ...(dlmm.status === 'fulfilled' ? dlmm.value : []),
    ...(damm.status === 'fulfilled' ? damm.value : []),
  ]
}

export function mergeDbAndLiveLpPositions(dbRows: any[], liveRows: LiveMeteoraPosition[]): any[] {
  if (liveRows.length === 0) return dbRows

  const liveByPubkey = new Map(liveRows.map(row => [row.position_pubkey, row]))
  const merged: any[] = []
  const seen = new Set<string>()

  for (const row of dbRows) {
    const live = liveByPubkey.get(row.position_pubkey)
    const isDamm = row.strategy_id === 'damm-edge' || row.position_type === 'damm-edge'
    const keepDbOnly = isDamm || row.dry_run === true || row.status === 'pending_retry'
    if (!live && !keepDbOnly) continue

    if (live) {
      seen.add(live.position_pubkey)
      merged.push({
        ...live,
        ...row,
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
