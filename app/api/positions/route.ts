import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { fetchLiveMeteoraPositions, mergeDbAndLiveLpPositions } from '@/lib/meteora-live'

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

  let liveLp: Awaited<ReturnType<typeof fetchLiveMeteoraPositions>> = []
  let liveLpOk = false
  if (status === 'all' || status === 'active' || status === 'out_of_range') {
    try {
      liveLp = await fetchLiveMeteoraPositions()
      liveLpOk = true
    } catch (err) {
      console.warn('[positions] Meteora live position fetch failed; using Supabase cache:', err)
    }
  }

  if (error && !liveLpOk) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const positions = mergeDbAndLiveLpPositions(data ?? [], liveLp, {
    liveFetchOk: liveLpOk,
    includeDbClosed: status === 'all' || status === 'closed',
  })

  return NextResponse.json({ positions, liveSource: liveLpOk ? 'meteora' : 'supabase-cache' })
}
