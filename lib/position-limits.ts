/**
 * lib/position-limits.ts
 *
 * Minimal concurrency control using local state + on-chain where possible.
 * No hard Supabase dependency for the zero-Supabase mode.
 */

import { getOpenLpPositions } from './local-state'

export const OPEN_LP_STATUSES = ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']

export type OpenLpLimitState = {
  effectiveOpenCount: number
  liveOpenCount?: number
  cachedOpenCount?: number
  countSource?: string
  liveFetchOk?: boolean
  dlmmOk?: boolean
}

export async function getOpenLpLimitState(): Promise<OpenLpLimitState> {
  try {
    const local = getOpenLpPositions()
    return { effectiveOpenCount: local.length }
  } catch {
    return { effectiveOpenCount: 0 }
  }
}

export function assertCanOpenLpPosition(..._args: any[]): void {
  // Simplified stack — no-op for now (can be enhanced later)
  // Accepts old call signatures for compatibility during transition
}
