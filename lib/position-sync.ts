import { fetchLiveMeteoraSnapshot, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { getSupabaseRestHeaders, getSupabaseUrl } from '@/lib/supabase'

interface CachedPosition {
  id: string
  symbol: string | null
  position_pubkey: string | null
  strategy_id: string | null
  position_type: string | null
  status: string | null
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
  insertedPositions: LiveMeteoraPosition[]
  positions: LiveMeteoraPosition[]
}

async function fetchCachedPositions(positionPubkeys: string[]): Promise<Map<string, CachedPosition[]>> {
  if (positionPubkeys.length === 0) return new Map()

  const filter = `position_pubkey=in.(${positionPubkeys.join(',')})`
  const select = 'select=id,symbol,position_pubkey,strategy_id,position_type,status,dry_run,metadata'
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
  const select = 'select=id,symbol,position_pubkey,strategy_id,position_type,status,dry_run,metadata'
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
  return {
    symbol: live.symbol,
    mint: live.mint,
    token_address: live.mint,
    pool_address: live.pool_address,
    strategy_id: live.strategy_id,
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
  }
}

function shouldRefreshSymbol(existing: CachedPosition): boolean {
  const symbol = String(existing.symbol ?? '')
  return !symbol || symbol === 'SOL' || /^(LIVE|DAMM|ORPHAN)-/.test(symbol) || existing.strategy_id === 'meteora-live' || existing.strategy_id === 'damm-live'
}

function shouldPreserveLocalStatus(existing: CachedPosition): boolean {
  return existing.status === 'closed' || existing.status === 'pending_close'
}

function updateBody(live: LiveMeteoraPosition, existing: CachedPosition): Record<string, unknown> {
  return {
    ...(shouldRefreshSymbol(existing) && { symbol: live.symbol }),
    mint: live.mint,
    token_address: live.mint,
    pool_address: live.pool_address,
    ...(!shouldPreserveLocalStatus(existing) && { status: live.status }),
    in_range: live.in_range,
    current_price: live.current_price,
    ...(live.claimable_fees_usd !== null && live.claimable_fees_usd !== undefined && {
      claimable_fees_usd: Math.round(live.claimable_fees_usd * 100) / 100,
    }),
    ...(live.position_value_usd !== null && live.position_value_usd !== undefined && {
      position_value_usd: Math.round(live.position_value_usd * 100) / 100,
    }),
    ...(live.pnl_usd !== null && live.pnl_usd !== undefined && {
      pnl_usd: Math.round(live.pnl_usd * 100) / 100,
    }),
    metadata: {
      ...(existing.metadata ?? {}),
      ...live.metadata,
      source_of_truth: 'meteora',
      meteora_live_status: live.status,
      synced_at: new Date().toISOString(),
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

function isDammCached(row: CachedPosition): boolean {
  return (
    row.strategy_id === 'damm-edge' ||
    row.strategy_id === 'damm-live' ||
    row.strategy_id === 'damm-migration' ||
    row.position_type === 'damm-edge' ||
    row.position_type === 'damm-migration'
  )
}

function isDlmmCached(row: CachedPosition): boolean {
  return !isDammCached(row)
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
  if (isDammCached(row)) return sourceOk.dammOk
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
    }
  }

  for (const cached of openCachedRows) {
    if (!shouldMarkExternallyClosed(cached, livePubkeys, snapshot)) continue
    await markCachedPositionExternallyClosed(cached)
    externallyClosed++
  }

  const dlmmLive = livePositions.filter(p => p.position_type === 'dlmm').length
  const dammLive = livePositions.filter(p => p.position_type === 'damm-edge').length
  const dlmmInserted = insertedPositions.filter(p => p.position_type === 'dlmm').length
  const dammInserted = insertedPositions.filter(p => p.position_type === 'damm-edge').length

  console.log(
    `[position-sync] Meteora sync done live=${livePositions.length} updated=${updated} inserted=${insertedPositions.length} closed=${externallyClosed} ` +
    `(source dlmm=${snapshot.dlmmOk ? 'ok' : 'failed'}, damm=${snapshot.dammOk ? 'ok' : 'failed'}) ` +
    `(dlmm live=${dlmmLive} inserted=${dlmmInserted}, damm live=${dammLive} inserted=${dammInserted})`,
  )

  return {
    live: livePositions.length,
    inserted: insertedPositions.length,
    updated,
    dlmmOk: snapshot.dlmmOk,
    dammOk: snapshot.dammOk,
    dlmmError: snapshot.dlmmError,
    dammError: snapshot.dammError,
    dlmmLive,
    dammLive,
    dlmmInserted,
    dammInserted,
    externallyClosed,
    insertedPositions,
    positions: livePositions,
  }
}
