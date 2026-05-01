import { fetchLiveMeteoraSnapshot } from '@/lib/meteora-live'
import { createServerClient } from '@/lib/supabase'

export const OPEN_LP_STATUSES = ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']

export interface OpenLpLimitState {
  effectiveOpenCount: number
  liveOpenCount: number
  cachedOpenCount: number
  liveFetchOk: boolean
  dlmmOk: boolean
  dammOk: boolean
}

export async function getOpenLpLimitState(): Promise<OpenLpLimitState> {
  const supabase = createServerClient()
  const [snapshot, cached] = await Promise.all([
    fetchLiveMeteoraSnapshot(),
    supabase
      .from('lp_positions')
      .select('id', { count: 'exact', head: true })
      .in('status', OPEN_LP_STATUSES),
  ])

  if (cached.error) {
    throw new Error(`lp_positions open count failed: ${cached.error.message}`)
  }

  const liveOpenCount = snapshot.positions.filter(position => !position.dry_run).length
  const cachedOpenCount = cached.count ?? 0
  const liveFetchOk = snapshot.dlmmOk && snapshot.dammOk

  return {
    effectiveOpenCount: Math.max(liveOpenCount, cachedOpenCount),
    liveOpenCount,
    cachedOpenCount,
    liveFetchOk,
    dlmmOk: snapshot.dlmmOk,
    dammOk: snapshot.dammOk,
  }
}

export async function assertCanOpenLpPosition(maxConcurrentPositions: number, label: string): Promise<OpenLpLimitState> {
  const state = await getOpenLpLimitState()

  if (!state.liveFetchOk) {
    throw new Error(
      `${label} live Meteora position count incomplete (dlmmOk=${state.dlmmOk}, dammOk=${state.dammOk}); refusing to open`,
    )
  }

  if (state.effectiveOpenCount >= maxConcurrentPositions) {
    throw new Error(
      `${label} max LP positions reached (${state.effectiveOpenCount}/${maxConcurrentPositions}; ` +
      `live=${state.liveOpenCount}, cached=${state.cachedOpenCount})`,
    )
  }

  return state
}
