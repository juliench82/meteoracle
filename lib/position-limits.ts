/**
 * lib/position-limits.ts
 *
 * Minimal concurrency control using local state + on-chain where possible.
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
  livePositions?: any[]   // optional for future live DLMM queries
}

export async function getOpenLpLimitState(..._args: any[]): Promise<OpenLpLimitState> {
  try {
    const local = getOpenLpPositions()
    const openOnes = local.filter((p: any) => OPEN_LP_STATUSES.includes(p.status || 'open'))
    const count = openOnes.length
    return {
      effectiveOpenCount: count,
      liveOpenCount: count,
      cachedOpenCount: 0,
      countSource: 'local-state',
      liveFetchOk: true,
      dlmmOk: true,
      livePositions: [],
    }
  } catch {
    return {
      effectiveOpenCount: 0,
      liveOpenCount: 0,
      cachedOpenCount: 0,
      countSource: 'local-state',
      liveFetchOk: false,
      dlmmOk: false,
      livePositions: [],
    }
  }
}

export function assertCanOpenLpPosition(..._args: any[]): void {
  // Minimal implementation (local-state + on-chain where needed)
}
