import { fetchLiveMeteoraSnapshot, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { getSupabaseRestHeaders, getSupabaseUrl } from '@/lib/supabase'
import { sendAlert } from '@/bot/alerter'

interface CachedPosition {
  id: string
  symbol: string | null
  position_pubkey: string | null
  strategy_id: string | null
  position_type: string | null
  status: string | null
  closed_at: string | null
  close_reason: string | null
  dry_run: boolean | null
  metadata: Record<string, unknown> | null
}

export interface MeteoraPositionSyncResult {
  live: number
  inserted: number
  updated: number
  dlmmOk: boolean
  dammOk: boolean
  dlmmError?: string | null
  dammError?: string | null
  dlmmLive: number
  dammLive: number
  dlmmInserted: number
  dammInserted: number
  externallyClosed: number
  ilStopped: number
  insertedPositions: LiveMeteoraPosition[]
  positions: LiveMeteoraPosition[]
}

let _syncFailCount = 0
const CLOSED_LIVE_REOPEN_GRACE_MS =
  parseInt(process.env.METEORA_CLOSED_LIVE_REOPEN_GRACE_SEC ?? '180', 10) * 1_000

// IL/PnL stop threshold — negative percentage, e.g. -5 means stop at -5%
// Override via METEORA_IL_STOP_PCT env var (e.g. "-8" for -8%)
const IL_STOP_PCT = parseFloat(process.env.METEORA_IL_STOP_PCT ?? '-5')

async function fetchCachedPositions(positionPubkeys: string[]): Promise<Map<string, CachedPosition[]>> {
  if (positionPubkeys.length === 0) return new Map()

  const filter = `position_pubkey=in.(${positionPubkeys.join(',')})`
  const select = 'select=id,symbol,position_pubkey,strategy_id,position_type,status,closed_at,close_reason,dry_run,metadata'
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions?${filter}&${select}`, {
    headers: getSupabaseRestHeaders('representation'),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`fetchCachedPositions ${res.status}: ${await res.text()}`)
  }

  const rows: CachedPosition[] = await res.json()
  const byPubkey = new Map<string, CachedPosition[]>()
  for (const row of rows) {
    if (!row.position_pubkey) continue
    byPubkey.set(row.position_pubkey, [...(byPubkey.get(row.position_pubkey) ?? []), row])
  }
  return byPubkey
}

async function fetchOpenCachedPositions(): Promise<CachedPosition[]> {
  const select = 'select=id,symbol,position_pubkey,strategy_id,position_type,status,closed_at,close_reason,dry_run,metadata'
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions?status=in.(active,open,out_of_range,orphaned)&${select}`, {
    headers: getSupabaseRestHeaders('representation'),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`fetchOpenCachedPositions ${res.status}: ${await res.text()}`)
  }

  return res.json()
}

function insertBody(live: LiveMeteoraPosition): Record<string, unknown> {
  const safeStrategyId = (live.strategy_id && live.strategy_id !== 'meteora-live')
    ? live.strategy_id
    : 'meteora-live';

  return {
    symbol: live.symbol,
    mint: live.mint,
    token_address: live.mint,
    pool_address: live.pool_address,
    strategy_id: safeStrategyId,
    entry_price: 0,
    entry_price_sol: 0,
    entry_price_usd: 0,
    current_price: live.current_price,
    sol_deposited: live.sol_deposited,
    token_amount: live.token_amount,
    claimable_fees_usd: live.claimable_fees_usd ?? 0,
    position_value_usd: live.position_value_usd ?? 0,
    pnl_usd: live.pnl_usd ?? 0,
    status: live.status,
    in_range: live.in_range,
    dry_run: false,
    position_type: live.position_type,
    opened_at: live.opened_at,
    position_pubkey: live.position_pubkey,
    metadata: {
      ...live.metadata,
      source_of_truth: 'meteora',
      detectedBy: 'wallet-position-sync',
      needs_strategy_review: true,
    },
  };
}

function shouldRefreshSymbol(existing: CachedPosition): boolean {
  const symbol = String(existing.symbol ?? '');
  if (symbol && symbol !== 'LIVE' && !/^(LIVE|DAMM|ORPHAN)-/.test(symbol)) return false;
  return !symbol || symbol === 'SOL' || /^(LIVE|DAMM|ORPHAN)-/.test(symbol) || existing.strategy_id === 'meteora-live' || existing.strategy_id === 'damm-live';
}

function closedRecently(existing: CachedPosition): boolean {
  const closedAt = Date.parse(existing.closed_at ?? '')
  return Number.isFinite(closedAt) && Date.now() - closedAt < CLOSED_LIVE_REOPEN_GRACE_MS
}

function shouldPreserveLocalStatus(existing: CachedPosition): boolean {
  if (existing.status === 'pending_close') return true
  return existing.status === 'closed' && closedRecently(existing)
}

function updateBody(live: LiveMeteoraPosition, existing: CachedPosition): Record<string, unknown> {
  const isProtectedStrategy = existing.strategy_id &&
    existing.strategy_id !== 'meteora-live' &&
    existing.strategy_id !== 'damm-live';

  const hasValidSymbol = existing.symbol && existing.symbol !== 'LIVE';
  const shouldUpdateSymbol = !isProtectedStrategy || !hasValidSymbol;

  if (isProtectedStrategy && hasValidSymbol && existing.symbol !== live.symbol) {
    console.log(`[position-sync] refusing to overwrite managed symbol id=${existing.id} pubkey=${existing.position_pubkey} old=${existing.symbol} new=${live.symbol}`);
  }
  const preserveLocalStatus = shouldPreserveLocalStatus(existing)
  const reviveClosedLive = existing.status === 'closed' && !preserveLocalStatus

  return {
    ...(shouldUpdateSymbol && { symbol: live.symbol }),
    mint: live.mint,
    token_address: live.mint,
    pool_address: live.pool_address,
    ...(!preserveLocalStatus && { status: live.status }),
    ...(reviveClosedLive && {
      closed_at: null,
      close_reason: null,
    }),
    in_range: live.in_range,
    current_price: live.current_price,
    sol_deposited: live.sol_deposited,
    token_amount: live.token_amount,
    ...(live.claimable_fees_usd !== null && live.claimable_fees_usd !== undefined && {
      claimable_fees_usd: Math.round(live.claimable_fees_usd * 100) / 100,
    }),
    ...(live.position_value_usd !== null && live.position_value_usd !== undefined && {
      position_value_usd: Math.round(live.position_value_usd * 100) / 100,
    }),
    ...(live.pnl_usd !== null && live.pnl_usd !== undefined && {
      pnl_usd: Math.round(live.pnl_usd * 100) / 100,
    }),
    ...(live.pnl_pct !== null && live.pnl_pct !== undefined && {
      pnl_pct: Math.round(live.pnl_pct * 100) / 100,
    }),
    metadata: {
      ...(existing.metadata ?? {}),
      ...live.metadata,
      source_of_truth: 'meteora',
      meteora_live_status: live.status,
      synced_at: new Date().toISOString(),
      ...(reviveClosedLive && {
        live_reopen_detected_at: new Date().toISOString(),
        previous_closed_at: existing.closed_at,
        previous_close_reason: existing.close_reason,
      }),
    },
  }
}

async function insertCachedPosition(live: LiveMeteoraPosition): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions`, {
    method: 'POST',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify(insertBody(live)),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok && res.status !== 409) {
    throw new Error(`insertCachedPosition ${res.status}: ${await res.text()}`)
  }
}

async function updateCachedPosition(live: LiveMeteoraPosition, existing: CachedPosition): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions?id=eq.${existing.id}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify(updateBody(live, existing)),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`updateCachedPosition ${res.status}: ${await res.text()}`)
  }
}

/**
 * Returns true if the position has breached the IL/PnL stop threshold.
 * Uses pnl_pct from the live snapshot (sourced from Meteora DLMM API position_pnl_pct).
 * Skips dry_run positions and positions already exiting.
 */
function shouldTriggerIlStop(live: LiveMeteoraPosition, existing: CachedPosition): boolean {
  if (existing.dry_run === true) return false
  if (existing.status === 'pending_close' || existing.status === 'closed') return false
  const pnlPct = live.pnl_pct
  if (pnlPct === null || pnlPct === undefined || !Number.isFinite(pnlPct)) return false
  return pnlPct <= IL_STOP_PCT
}

async function markIlStop(existing: CachedPosition, live: LiveMeteoraPosition): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions?id=eq.${existing.id}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify({
      status: 'pending_close',
      close_reason: 'il_stop',
      metadata: {
        ...(existing.metadata ?? {}),
        il_stop_triggered_at: new Date().toISOString(),
        il_stop_pnl_pct: live.pnl_pct,
        il_stop_pnl_usd: live.pnl_usd ?? null,
        il_stop_threshold_pct: IL_STOP_PCT,
      },
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`markIlStop ${res.status}: ${await res.text()}`)
  }
}

function isDlmmCached(row: CachedPosition): boolean {
  // DAMM v2 fully removed — all remaining positions are treated as DLMM
  return true
}

function shouldMarkExternallyClosed(
  row: CachedPosition,
  livePubkeys: Set<string>,
  sourceOk: { dlmmOk: boolean; dammOk: boolean },
): boolean {
  const pubkey = row.position_pubkey
  if (!pubkey || pubkey === 'DRY_RUN') return false
  if (row.dry_run === true) return false
  if (livePubkeys.has(pubkey)) return false
  // DAMM v2 fully removed — all positions treated as DLMM for sync purposes
  if (isDlmmCached(row)) return sourceOk.dlmmOk
  return false
}

async function markCachedPositionExternallyClosed(row: CachedPosition): Promise<void> {
  const res = await fetch(`${getSupabaseUrl()}/rest/v1/lp_positions?id=eq.${row.id}`, {
    method: 'PATCH',
    headers: getSupabaseRestHeaders('minimal'),
    body: JSON.stringify({
      status: 'closed',
      closed_at: new Date().toISOString(),
      close_reason: 'external_close_detected',
      in_range: false,
      oor_since_at: null,
      metadata: {
        ...(row.metadata ?? {}),
        source_of_truth: 'meteora',
        external_close_detected_at: new Date().toISOString(),
      },
    }),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`markCachedPositionExternallyClosed ${res.status}: ${await res.text()}`)
  }
}

export async function syncAllMeteoraPositions(): Promise<MeteoraPositionSyncResult> {
  try {
    const snapshot = await fetchLiveMeteoraSnapshot()
    const livePositions = snapshot.positions
    const liveWithPubkeys = livePositions.filter(p => p.position_pubkey && p.position_pubkey !== 'DRY_RUN')
    const [cachedByPubkey, openCachedRows] = await Promise.all([
      fetchCachedPositions(liveWithPubkeys.map(p => p.position_pubkey)),
      fetchOpenCachedPositions(),
    ])
    const livePubkeys = new Set(liveWithPubkeys.map(p => p.position_pubkey))

    const insertedPositions: LiveMeteoraPosition[] = []
    let updated = 0
    let externallyClosed = 0
    let ilStopped = 0

    for (const live of liveWithPubkeys) {
      const cachedRows = cachedByPubkey.get(live.position_pubkey) ?? []

      if (cachedRows.length === 0) {
        await insertCachedPosition(live)
        insertedPositions.push(live)
        continue
      }

      for (const cached of cachedRows) {
        await updateCachedPosition(live, cached)
        updated++

        if (shouldTriggerIlStop(live, cached)) {
          await markIlStop(cached, live)
          ilStopped++
          const msg = `[position-sync] IL stop triggered for ${cached.symbol ?? cached.position_pubkey} — pnl_pct=${live.pnl_pct}% (threshold=${IL_STOP_PCT}%)`
          console.warn(msg)
          await sendAlert({
            type: 'warning',
            message: msg,
          }).catch(() => {})
        }
      }
    }

    for (const cached of openCachedRows) {
      if (!shouldMarkExternallyClosed(cached, livePubkeys, snapshot)) continue
      await markCachedPositionExternallyClosed(cached)
      externallyClosed++
    }

    const dlmmLive = livePositions.filter(p => p.position_type === 'dlmm').length
    const dammLive = 0
    const dlmmInserted = insertedPositions.filter(p => p.position_type === 'dlmm').length
    const dammInserted = 0

    console.log(
      `[position-sync] Meteora sync done live=${livePositions.length} updated=${updated} inserted=${insertedPositions.length} closed=${externallyClosed} il_stopped=${ilStopped} ` +
      `(source dlmm=${snapshot.dlmmOk ? 'ok' : 'failed'}) ` +
      `(dlmm live=${dlmmLive} inserted=${dlmmInserted})`,
    )

    _syncFailCount = 0

    return {
      live: livePositions.length,
      inserted: insertedPositions.length,
      updated,
      dlmmOk: snapshot.dlmmOk,
      dammOk: false,
      dlmmError: snapshot.dlmmError,
      dammError: null,
      dlmmLive,
      dammLive: 0,
      dlmmInserted,
      dammInserted: 0,
      externallyClosed,
      ilStopped,
      insertedPositions,
      positions: livePositions,
    }
  } catch (err) {
    _syncFailCount++
    const msg = `[position-sync] sync failed (${_syncFailCount}× consecutive): ${
      err instanceof Error ? err.message : String(err)
    }`
    console.warn(msg)
    if (_syncFailCount >= 3) {
      await sendAlert({ type: 'error', message: msg }).catch(() => {})
    }
    throw err
  }
}
