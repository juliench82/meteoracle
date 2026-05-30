/**
 * lib/position-limits.ts
 *
 * Minimal concurrency control using local state + on-chain where possible.
 * No hard Supabase dependency for the zero-Supabase mode.
 */

import { getOpenLpPositions } from './local-state'

export const OPEN_LP_STATUSES = ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']

export async function getOpenLpLimitState(): Promise<{ effectiveOpenCount: number }> {
  try {
    // Primary source: local state
    const local = getOpenLpPositions()
    return { effectiveOpenCount: local.length }
  } catch {
    return { effectiveOpenCount: 0 }
  }
}
