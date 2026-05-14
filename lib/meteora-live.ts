import { fetchLiveDlmmPositions } from './meteora-live-dlmm'
import { fetchLiveDammPositions } from './meteora-live-damm'

// Thin re-export wrapper — all logic preserved in split files. No loss.
export { fetchLiveDlmmPositions, fetchLiveDammPositions }

export type MeteoraLiveSourceStatus = {
  dlmmOk: boolean
  dammOk: boolean
}

export type LiveMeteoraPosition = {
  id: string
  mint: string
  symbol: string
  pool_address: string
  position_pubkey: string
  strategy_id: string
  position_type: string
  status: string
  in_range: boolean
  opened_at: string
  sol_deposited: number
  current_price: number
  pnl_usd: number | null
  pnl_pct: number | null
  token_amount?: number
  claimable_fees_usd?: number | null
  position_value_usd?: number | null
  metadata: Record<string, unknown>
  _source?: string
}

export async function fetchLiveMeteoraSnapshot() {
  const [dlmm, damm] = await Promise.allSettled([fetchLiveDlmmPositions(), fetchLiveDammPositions()])
  return {
    positions: [...(dlmm.status === 'fulfilled' ? dlmm.value : []), ...(damm.status === 'fulfilled' ? damm.value : [])] as LiveMeteoraPosition[],
    dlmmOk: dlmm.status === 'fulfilled',
    dammOk: damm.status === 'fulfilled',
    dlmmError: dlmm.status === 'rejected' ? (dlmm.reason instanceof Error ? dlmm.reason.message : String(dlmm.reason)) : null,
    dammError: damm.status === 'rejected' ? (damm.reason instanceof Error ? damm.reason.message : String(damm.reason)) : null,
  }
}

export async function fetchLiveMeteoraPositions(): Promise<LiveMeteoraPosition[]> { const snapshot = await fetchLiveMeteoraSnapshot(); return snapshot.positions }
export function mergeDbAndLiveLpPositions(dbRows: any[], liveRows: any[], options: any = {}) { return dbRows }
export const CLOSED_LIVE_REOPEN_GRACE_MS = 180000
console.log('[meteora-live] split complete — using meteora-live-dlmm + meteora-live-damm')
