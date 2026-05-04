import { fetchLiveMeteoraSnapshot, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { createServerClient } from '@/lib/supabase'

export const OPEN_LP_STATUSES = ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']

export type OpenLpScope = 'all' | 'market' | 'damm-migration'

export interface OpenLpLimitState {
  effectiveOpenCount: number
  liveOpenCount: number
  liveScopedOpenCount: number
  cachedOpenCount: number
  liveFetchOk: boolean
  dlmmOk: boolean
  dammOk: boolean
  countSource: 'meteora-live' | 'supabase-cache'
  livePositions: LiveMeteoraPosition[]
}

function isDammMigrationPosition(position: { strategy_id?: string | null; position_type?: string | null }): boolean {
  return (
    position.strategy_id === 'damm-migration' ||
    position.position_type === 'damm-migration'
  )
}

export function matchesOpenLpScope(
  position: { strategy_id?: string | null; position_type?: string | null },
  scope: OpenLpScope,
): boolean {
  if (scope === 'all') return true
  const isMigration = isDammMigrationPosition(position)
  return scope === 'damm-migration' ? isMigration : !isMigration
}

function isLiveDammPosition(position: LiveMeteoraPosition): boolean {
  return position.position_type === 'damm-edge' || position.strategy_id === 'damm-live'
}

function liveOpenCountForScope(positions: LiveMeteoraPosition[], scope: OpenLpScope): number {
  const live = positions.filter(position => !position.dry_run)
  if (scope === 'all') return live.length

  // Meteora live data cannot know our local strategy_id before Supabase sync.
  // For migration safety, any live DAMM v2 position occupies the migration slot.
  if (scope === 'damm-migration') {
    return live.filter(isLiveDammPosition).length
  }

  return live.filter(position => !isLiveDammPosition(position)).length
}

export async function getOpenLpLimitState(scope: OpenLpScope = 'all'): Promise<OpenLpLimitState> {
  const supabase = createServerClient()
  const [snapshot, cached] = await Promise.all([
    fetchLiveMeteoraSnapshot(),
    supabase
      .from('lp_positions')
      .select('id, strategy_id, position_type')
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
  const liveScopedOpenCount = liveOpenCountForScope(snapshot.positions, scope)
  const cachedRows = cached.error ? [] : cached.data ?? []
  const cachedOpenCount = cachedRows.filter(position => matchesOpenLpScope(position, scope)).length
  const effectiveOpenCount = liveFetchOk ? Math.max(liveScopedOpenCount, cachedOpenCount) : cachedOpenCount
  const countSource = liveFetchOk && liveScopedOpenCount >= cachedOpenCount ? 'meteora-live' : 'supabase-cache'

  return {
    effectiveOpenCount,
    liveOpenCount,
    liveScopedOpenCount,
    cachedOpenCount,
    liveFetchOk,
    dlmmOk: snapshot.dlmmOk,
    dammOk: snapshot.dammOk,
    countSource,
    livePositions: snapshot.positions,
  }
}

export async function assertCanOpenLpPosition(
  maxConcurrentPositions: number,
  label: string,
  scope: OpenLpScope = 'all',
): Promise<OpenLpLimitState> {
  const state = await getOpenLpLimitState(scope)

  if (state.effectiveOpenCount >= maxConcurrentPositions) {
    throw new Error(
      `${label} max ${scope} LP positions reached (${state.effectiveOpenCount}/${maxConcurrentPositions}; ` +
      `source=${state.countSource}, live=${state.liveOpenCount}, cached=${state.cachedOpenCount})`,
    )
  }

  return state
}
