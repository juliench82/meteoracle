import { fetchLiveMeteoraSnapshot, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { createServerClient } from '@/lib/supabase'

export const OPEN_LP_STATUSES = ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']

export interface OpenLpLimitState {
  effectiveOpenCount: number
  liveOpenCount: number
  cachedOpenCount: number
  liveFetchOk: boolean
  dlmmOk: boolean
  dammOk: boolean
  countSource: 'meteora-live' | 'supabase-cache'
  livePositions: LiveMeteoraPosition[]
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

  const liveFetchOk = snapshot.dlmmOk && snapshot.dammOk

  if (cached.error && !liveFetchOk) {
    throw new Error(`lp_positions open count failed: ${cached.error.message}`)
  }
  if (cached.error) {
    console.warn(`[position-limits] cached open count failed; using Meteora live count only: ${cached.error.message}`)
  }

  const liveOpenCount = snapshot.positions.filter(position => !position.dry_run).length
  const cachedOpenCount = cached.error ? 0 : cached.count ?? 0
  const countSource = liveFetchOk ? 'meteora-live' : 'supabase-cache'

  return {
    effectiveOpenCount: liveFetchOk ? liveOpenCount : cachedOpenCount,
    liveOpenCount,
    cachedOpenCount,
    liveFetchOk,
    dlmmOk: snapshot.dlmmOk,
    dammOk: snapshot.dammOk,
    countSource,
    livePositions: snapshot.positions,
  }
}

export async function assertCanOpenLpPosition(maxConcurrentPositions: number, label: string): Promise<OpenLpLimitState> {
  const state = await getOpenLpLimitState()

  if (state.effectiveOpenCount >= maxConcurrentPositions) {
    throw new Error(
      `${label} max LP positions reached (${state.effectiveOpenCount}/${maxConcurrentPositions}; ` +
      `source=${state.countSource}, live=${state.liveOpenCount}, cached=${state.cachedOpenCount})`,
    )
  }

  return state
}
