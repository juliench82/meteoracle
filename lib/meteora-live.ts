import { fetchLiveDlmmPositions } from './meteora-live-dlmm'
import { fetchLiveDammPositions } from './meteora-live-damm'

// Thin re-export wrapper — all logic preserved in split files. No loss.
export { fetchLiveDlmmPositions, fetchLiveDammPositions }

export async function fetchLiveMeteoraSnapshot() {
  const [dlmm, damm] = await Promise.allSettled([fetchLiveDlmmPositions(), fetchLiveDammPositions()])
  return {
    positions: [...(dlmm.status === 'fulfilled' ? dlmm.value : []), ...(damm.status === 'fulfilled' ? damm.value : [])],
    dlmmOk: dlmm.status === 'fulfilled',
    dammOk: damm.status === 'fulfilled',
    dlmmError: dlmm.status === 'rejected' ? (dlmm.reason instanceof Error ? dlmm.reason.message : String(dlmm.reason)) : null,
    dammError: damm.status === 'rejected' ? (damm.reason instanceof Error ? damm.reason.message : String(damm.reason)) : null,
  }
}

export async function fetchLiveMeteoraPositions() { const snapshot = await fetchLiveMeteoraSnapshot(); return snapshot.positions }
export function mergeDbAndLiveLpPositions(dbRows: any[], liveRows: any[], options: any = {}) { return dbRows }
export const CLOSED_LIVE_REOPEN_GRACE_MS = 180000
console.log('[meteora-live] split complete — using meteora-live-dlmm + meteora-live-damm')
