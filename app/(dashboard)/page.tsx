import { createServerClient } from '@/lib/supabase'
import { DashboardClient } from '@/components/dashboard/DashboardClient'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = createServerClient()

  const [openSpotRes, closedSpotRes, openLpRes, closedLpRes] = await Promise.allSettled([
    supabase.from('spot_positions').select('*').eq('status', 'open').order('opened_at', { ascending: false }),
    supabase.from('spot_positions').select('*').in('status', ['closed_tp', 'closed_sl', 'closed_manual', 'closed_timeout']).order('closed_at', { ascending: false }).limit(50),
    supabase.from('lp_positions').select('*').in('status', ['active', 'out_of_range']).order('opened_at', { ascending: false }),
    supabase.from('lp_positions').select('*').eq('status', 'closed').order('closed_at', { ascending: false }).limit(50),
  ])

  const initialData = {
    openSpot:   openSpotRes.status   === 'fulfilled' ? (openSpotRes.value.data   ?? []) : [],
    closedSpot: closedSpotRes.status === 'fulfilled' ? (closedSpotRes.value.data ?? []) : [],
    openLp:     openLpRes.status     === 'fulfilled' ? (openLpRes.value.data     ?? []) : [],
    closedLp:   closedLpRes.status   === 'fulfilled' ? (closedLpRes.value.data   ?? []) : [],
  }

  return <DashboardClient initialData={initialData} />
}
