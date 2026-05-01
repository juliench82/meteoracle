import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'
import { fetchLiveMeteoraPositions } from '@/lib/meteora-live'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServerClient()

  const [stateRes, lastTickRes, lpCountRes, spotCountRes, liveLpRes] = await Promise.allSettled([
    getBotState(),
    supabase
      .from('bot_logs')
      .select('created_at, payload')
      .eq('event', 'bot_tick')
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from('lp_positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range']),
    supabase
      .from('spot_positions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'open'),
    fetchLiveMeteoraPositions(),
  ])

  const state      = stateRes.status      === 'fulfilled' ? stateRes.value      : { enabled: false, dry_run: true }
  const lastTick   = lastTickRes.status   === 'fulfilled' ? lastTickRes.value.data : null
  const lpCount    = lpCountRes.status    === 'fulfilled' ? (lpCountRes.value.count   ?? 0) : 0
  const spotCount  = spotCountRes.status  === 'fulfilled' ? (spotCountRes.value.count  ?? 0) : 0
  const liveLpCount = liveLpRes.status     === 'fulfilled' ? liveLpRes.value.length : 0
  const liveDammCount = liveLpRes.status   === 'fulfilled'
    ? liveLpRes.value.filter(p => p.position_type === 'damm-edge').length
    : 0
  const liveDlmmCount = liveLpRes.status   === 'fulfilled'
    ? liveLpRes.value.filter(p => p.position_type === 'dlmm').length
    : 0

  return NextResponse.json({
    enabled:         state.enabled,
    dryRun:          state.dry_run,
    lastTickAt:      lastTick?.created_at ?? null,
    lastTickPayload: lastTick?.payload    ?? null,
    openPositions:   Math.max(lpCount, liveLpCount) + spotCount,
    lpPositions:     Math.max(lpCount, liveLpCount),
    meteoraLiveLpPositions: liveLpCount,
    meteoraLiveDlmmPositions: liveDlmmCount,
    meteoraLiveDammPositions: liveDammCount,
    spotPositions:   spotCount,
  })
}
