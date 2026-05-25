import { fetchLiveMeteoraSnapshot, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { createServerClient } from '@/lib/supabase'
import { getConnection, getWallet } from '@/lib/solana'

export const OPEN_LP_STATUSES = ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']

export type OpenLpScope = 'all' | 'market' // DAMM v2 fully removed from the bot

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

export function matchesOpenLpScope(
  position: { strategy_id?: string | null; position_type?: string | null },
  scope: OpenLpScope,
): boolean {
  return scope === 'all' || scope === 'market'
}

function liveOpenCountForScope(positions: LiveMeteoraPosition[], scope: OpenLpScope): number {
  const live = positions.filter(position => !position.dry_run)
  return live.length
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

/** Live wallet balance guard — called before every open/rebalance to prevent reserve breach across processes */
export async function assertWalletHasReserve(label: string): Promise<number> {
  const connection = getConnection()
  const wallet = getWallet()
  const lamports = await connection.getBalance(wallet.publicKey, 'confirmed')
  const sol = lamports / 1_000_000_000
  const minReserve = parseFloat(process.env.WALLET_MIN_SOL_RESERVE ?? '0.5')
  const buffer = 0.05 // extra for fees + rebalance

  if (sol < minReserve + buffer) {
    throw new Error(
      `${label} wallet ${sol.toFixed(3)} SOL < reserve ${minReserve} + ${buffer} buffer — aborting to protect funds`,
    )
  }
  return sol
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

  await assertWalletHasReserve(label) // cross-process safety net

  return state
}
