import { PublicKey } from '@solana/web3.js'
import { getConnection, getWallet } from '@/lib/solana'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

async function getDLMM() {
  const mod = await import('@meteora-ag/dlmm')
  return mod.default as typeof import('@meteora-ag/dlmm').default
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
  dry_run: boolean
  metadata: Record<string, unknown>
  _source: 'meteora-live'
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

export function mergeDbAndLiveLpPositions(dbRows: any[], liveRows: LiveDlmmPosition[]): any[] {
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
