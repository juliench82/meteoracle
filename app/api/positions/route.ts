import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { fetchLiveMeteoraSnapshot, mergeDbAndLiveLpPositions, type MeteoraLiveSourceStatus } from '@/lib/meteora-live'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? 'active'
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100)

  const supabase = createServerClient()

  let query = supabase
    .from('lp_positions')
    .select('*')
    .order('opened_at', { ascending: false })
    .limit(limit)

  if (status !== 'all') {
    if (status === 'active') {
      query = query.in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry'])
    } else {
      query = query.eq('status', status)
    }
  }

  const { data, error } = await query

  let liveLp: Awaited<ReturnType<typeof fetchLiveMeteoraSnapshot>>['positions'] = []
  let liveSource: MeteoraLiveSourceStatus = { dlmmOk: false, dammOk: false }
  if (status === 'all' || status === 'active' || status === 'out_of_range') {
    try {
      const snapshot = await fetchLiveMeteoraSnapshot()
      liveLp = snapshot.positions
      liveSource = { dlmmOk: snapshot.dlmmOk, dammOk: snapshot.dammOk }
      if (!snapshot.dlmmOk || !snapshot.dammOk) {
        console.warn('[positions] partial Meteora live fetch failure:', {
          dlmm: snapshot.dlmmError,
          damm: snapshot.dammError,
        })
      }
    } catch (err) {
      console.warn('[positions] Meteora live position fetch failed; using Supabase cache:', err)
    }
  }

  const liveOk = liveSource.dlmmOk || liveSource.dammOk
  if (error && !liveOk) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const positions = mergeDbAndLiveLpPositions(data ?? [], liveLp, {
    ...liveSource,
    includeDbClosed: status === 'all' || status === 'closed',
  })

  return NextResponse.json({
    positions,
    liveSource: liveOk ? 'meteora' : 'supabase-cache',
    meteoraLive: {
      ok: liveOk,
      dlmmOk: liveSource.dlmmOk,
      dammOk: liveSource.dammOk,
      count: liveLp.length,
    },
  })
}
