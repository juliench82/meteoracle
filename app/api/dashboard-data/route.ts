import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServerClient()

  const [openSpotRes, closedSpotRes, openLpRes, closedLpRes, watchlistRes] = await Promise.allSettled([
    supabase.from('spot_positions').select('*').eq('status', 'open').order('opened_at', { ascending: false }),
    supabase.from('spot_positions').select('*').in('status', ['closed_tp', 'closed_sl', 'closed_manual', 'closed_timeout']).order('closed_at', { ascending: false }).limit(50),
    supabase.from('lp_positions').select('*').in('status', ['active', 'out_of_range', 'pending_retry']).order('opened_at', { ascending: false }),
    supabase.from('lp_positions').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(50),
    supabase.from('pre_grad_watchlist').select('*').order('detected_at', { ascending: false }).limit(20),
  ])

  return NextResponse.json({
    openSpot:   openSpotRes.status   === 'fulfilled' ? (openSpotRes.value.data   ?? []) : [],
    closedSpot: closedSpotRes.status === 'fulfilled' ? (closedSpotRes.value.data ?? []) : [],
    openLp:     openLpRes.status     === 'fulfilled' ? (openLpRes.value.data     ?? []) : [],
    closedLp:   closedLpRes.status   === 'fulfilled' ? (closedLpRes.value.data   ?? []) : [],
    watchlist:  watchlistRes.status  === 'fulfilled' ? (watchlistRes.value.data  ?? []) : [],
  })
}
