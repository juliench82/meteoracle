import { fetchLiveDlmmPositions } from './meteora-live-dlmm'

// Thin re-export wrapper — DAMM v2 fully removed
export { fetchLiveDlmmPositions }

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
  dry_run?: boolean | null
  metadata: Record<string, unknown>
  _source?: string
}

export async function fetchLiveMeteoraSnapshot() {
  // DAMM v2 fully removed — only DLMM live data
  const dlmm = await fetchLiveDlmmPositions().catch(err => ({ error: err }))
  const positions = 'error' in dlmm ? [] : dlmm as any[]
  return {
    positions: positions as LiveMeteoraPosition[],
    dlmmOk: !('error' in dlmm),
    dammOk: false,
    dlmmError: 'error' in dlmm ? (dlmm.error instanceof Error ? dlmm.error.message : String(dlmm.error)) : null,
    dammError: null,
  }
}

export async function fetchLiveMeteoraPositions(): Promise<LiveMeteoraPosition[]> { const snapshot = await fetchLiveMeteoraSnapshot(); return snapshot.positions }

export const CLOSED_LIVE_REOPEN_GRACE_MS = 180000

/**
 * Merges DB lp_positions rows with fresh live Meteora snapshot data.
 * Live data wins for price, range status, fees, and PnL values.
 * DB data wins for strategy, opened_at, sol_deposited (authoritative), etc.
 */
export function mergeDbAndLiveLpPositions(dbRows: any[], liveRows: any[], _options: any = {}): any[] {
  if (!liveRows || liveRows.length === 0) return dbRows

  const liveByPubkey = new Map<string, any>()
  for (const live of liveRows) {
    if (live.position_pubkey) {
      liveByPubkey.set(live.position_pubkey, live)
    }
  }

  return dbRows.map((dbRow) => {
    const live = liveByPubkey.get(dbRow.position_pubkey)
    if (!live) return dbRow

    // Prefer live values for fields the monitor needs for exit decisions
    const merged = {
      ...dbRow,
      current_price: typeof live.current_price === 'number' && live.current_price > 0
        ? live.current_price
        : dbRow.current_price,
      in_range: typeof live.in_range === 'boolean' ? live.in_range : dbRow.in_range,
      claimable_fees_usd:
        live.claimable_fees_usd != null ? live.claimable_fees_usd : dbRow.claimable_fees_usd,
      position_value_usd:
        live.position_value_usd != null ? live.position_value_usd : dbRow.position_value_usd,
      pnl_usd: live.pnl_usd != null ? live.pnl_usd : dbRow.pnl_usd,
      pnl_pct: live.pnl_pct != null ? live.pnl_pct : dbRow.pnl_pct,
      sol_deposited:
        typeof live.sol_deposited === 'number' && live.sol_deposited > 0
          ? live.sol_deposited
          : dbRow.sol_deposited,
    }

    // Merge metadata (live source_of_truth is useful)
    if (live.metadata && typeof live.metadata === 'object') {
      merged.metadata = {
        ...(dbRow.metadata ?? {}),
        ...live.metadata,
        live_synced_at: new Date().toISOString(),
      }
    }

    return merged
  })
}

console.log('[meteora-live] split complete — using meteora-live-dlmm + meteora-live-damm')
