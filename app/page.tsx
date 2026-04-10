import { createServerClient } from '@/lib/supabase'
import { DashboardRefresher } from '@/components/dashboard/DashboardRefresher'
import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { SpotKPIBar } from '@/components/dashboard/SpotKPIBar'
import { SpotPositionsTable } from '@/components/dashboard/SpotPositionsTable'
import { WatchlistFeed } from '@/components/dashboard/WatchlistFeed'
import { SpotPnlChart } from '@/components/dashboard/SpotPnlChart'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = createServerClient()

  const [openRes, closedRes, watchlistRes] = await Promise.allSettled([
    supabase
      .from('spot_positions')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: false }),
    supabase
      .from('spot_positions')
      .select('*')
      .in('status', ['closed_tp', 'closed_sl'])
      .order('closed_at', { ascending: false })
      .limit(50),
    supabase
      .from('pre_grad_watchlist')
      .select('*')
      .order('detected_at', { ascending: false })
      .limit(20),
  ])

  const openPositions  = openRes.status    === 'fulfilled' ? (openRes.value.data    ?? []) : []
  const closedPositions = closedRes.status === 'fulfilled' ? (closedRes.value.data   ?? []) : []
  const watchlist      = watchlistRes.status === 'fulfilled' ? (watchlistRes.value.data ?? []) : []

  // KPI calculations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const solDeployed  = openPositions.reduce((s: number, p: any) => s + (p.amount_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalPnl     = closedPositions.reduce((s: number, p: any) => s + (p.pnl_sol ?? 0), 0)
  const wins         = closedPositions.filter((p: any) => (p.pnl_sol ?? 0) > 0).length
  const winRate      = closedPositions.length > 0
    ? Math.round((wins / closedPositions.length) * 100)
    : null

  return (
    <div className="flex h-screen overflow-hidden">
      <DashboardRefresher intervalMs={30_000} />
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6 space-y-6">

          <SpotKPIBar
            solDeployed={solDeployed}
            openPositions={openPositions.length}
            totalPnlSol={totalPnl}
            winRate={winRate}
            totalTrades={closedPositions.length}
            watchlistCount={watchlist.length}
          />

          <SpotPnlChart closedPositions={closedPositions} />

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              <SpotPositionsTable
                openPositions={openPositions}
                closedPositions={closedPositions.slice(0, 20)}
              />
            </div>
            <div>
              <WatchlistFeed watchlist={watchlist} />
            </div>
          </div>

        </main>
      </div>
    </div>
  )
}
