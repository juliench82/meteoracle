import { fetchLiveMeteoraPositions, type LiveMeteoraPosition } from '@/lib/meteora-live'

interface CachedPosition {
  id: string
  position_pubkey: string | null
  strategy_id: string | null
  position_type: string | null
  status: string | null
  metadata: Record<string, unknown> | null
}

export interface MeteoraPositionSyncResult {
  live: number
  inserted: number
  updated: number
  dlmmLive: number
  dammLive: number
  dlmmInserted: number
  dammInserted: number
  insertedPositions: LiveMeteoraPosition[]
}

function sbUrl(): string {
  const u = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!u) throw new Error('SUPABASE_URL not set')
  return u
}

function sbKey(): string {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!k) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set')
  return k
}

function sbHeaders(prefer: 'minimal' | 'representation' = 'minimal') {
  return {
    apikey: sbKey(),
    Authorization: `Bearer ${sbKey()}`,
    'Content-Type': 'application/json',
    Prefer: `return=${prefer}`,
  }
}

async function fetchCachedPositions(positionPubkeys: string[]): Promise<Map<string, CachedPosition[]>> {
  if (positionPubkeys.length === 0) return new Map()

  const filter = `position_pubkey=in.(${positionPubkeys.join(',')})`
  const select = 'select=id,position_pubkey,strategy_id,position_type,status,metadata'
  const res = await fetch(`${sbUrl()}/rest/v1/lp_positions?${filter}&${select}`, {
    headers: sbHeaders('representation'),
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

function insertBody(live: LiveMeteoraPosition): Record<string, unknown> {
  return {
    symbol: live.symbol,
    mint: live.mint,
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

function updateBody(live: LiveMeteoraPosition, existing: CachedPosition): Record<string, unknown> {
  return {
    status: live.status,
    in_range: live.in_range,
    current_price: live.current_price,
    ...(live.claimable_fees_usd !== null && live.claimable_fees_usd !== undefined && {
      claimable_fees_usd: Math.round(live.claimable_fees_usd * 100) / 100,
    }),
    ...(live.position_value_usd !== null && live.position_value_usd !== undefined && {
      position_value_usd: Math.round(live.position_value_usd * 100) / 100,
    }),
    metadata: {
      ...(existing.metadata ?? {}),
      ...live.metadata,
      source_of_truth: 'meteora',
      synced_at: new Date().toISOString(),
    },
  }
}

async function insertCachedPosition(live: LiveMeteoraPosition): Promise<void> {
  const res = await fetch(`${sbUrl()}/rest/v1/lp_positions`, {
    method: 'POST',
    headers: sbHeaders('minimal'),
    body: JSON.stringify(insertBody(live)),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok && res.status !== 409) {
    throw new Error(`insertCachedPosition ${res.status}: ${await res.text()}`)
  }
}

async function updateCachedPosition(live: LiveMeteoraPosition, existing: CachedPosition): Promise<void> {
  const res = await fetch(`${sbUrl()}/rest/v1/lp_positions?id=eq.${existing.id}`, {
    method: 'PATCH',
    headers: sbHeaders('minimal'),
    body: JSON.stringify(updateBody(live, existing)),
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`updateCachedPosition ${res.status}: ${await res.text()}`)
  }
}

export async function syncAllMeteoraPositions(): Promise<MeteoraPositionSyncResult> {
  const livePositions = await fetchLiveMeteoraPositions()
  const liveWithPubkeys = livePositions.filter(p => p.position_pubkey && p.position_pubkey !== 'DRY_RUN')
  const cachedByPubkey = await fetchCachedPositions(liveWithPubkeys.map(p => p.position_pubkey))

  const insertedPositions: LiveMeteoraPosition[] = []
  let updated = 0

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

  const dlmmLive = livePositions.filter(p => p.position_type === 'dlmm').length
  const dammLive = livePositions.filter(p => p.position_type === 'damm-edge').length
  const dlmmInserted = insertedPositions.filter(p => p.position_type === 'dlmm').length
  const dammInserted = insertedPositions.filter(p => p.position_type === 'damm-edge').length

  console.log(
    `[position-sync] Meteora sync done live=${livePositions.length} updated=${updated} inserted=${insertedPositions.length} ` +
    `(dlmm live=${dlmmLive} inserted=${dlmmInserted}, damm live=${dammLive} inserted=${dammInserted})`,
  )

  return {
    live: livePositions.length,
    inserted: insertedPositions.length,
    updated,
    dlmmLive,
    dammLive,
    dlmmInserted,
    dammInserted,
    insertedPositions,
  }
}
