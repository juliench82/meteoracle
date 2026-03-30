import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export async function GET() {
  const supabase = createServerClient()

  const [lastTickRes, openCountRes] = await Promise.allSettled([
    supabase
      .from('bot_logs')
      .select('created_at, payload')
      .eq('event', 'bot_tick')
      .order('created_at', { ascending: false })
      .limit(1)
      .single(),
    supabase
      .from('positions')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'out_of_range']),
  ])

  const lastTick =
    lastTickRes.status === 'fulfilled' ? lastTickRes.value.data : null
  const openCount =
    openCountRes.status === 'fulfilled' ? openCountRes.value.count : 0

  return NextResponse.json({
    enabled: process.env.BOT_ENABLED === 'true',
    dryRun: process.env.BOT_DRY_RUN === 'true',
    lastTickAt: lastTick?.created_at ?? null,
    lastTickPayload: lastTick?.payload ?? null,
    openPositions: openCount,
  })
}
