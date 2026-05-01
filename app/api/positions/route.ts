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
      query = query.in('status', ['active', 'out_of_range', 'orphaned'])
    } else {
      query = query.eq('status', status)
    }
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let liveLp: Awaited<ReturnType<typeof fetchLiveMeteoraPositions>> = []
  if (status === 'all' || status === 'active' || status === 'out_of_range') {
    try {
      liveLp = await fetchLiveMeteoraPositions()
    } catch (err) {
      console.warn('[positions] Meteora live position fetch failed; using Supabase cache:', err)
    }
  }

  const positions = mergeDbAndLiveLpPositions(data ?? [], liveLp)

  return NextResponse.json({ positions })
}
