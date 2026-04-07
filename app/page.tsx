import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { KPIBar } from '@/components/dashboard/KPIBar'
import { PositionsTable } from '@/components/dashboard/PositionsTable'
import { CandidateFeed } from '@/components/dashboard/CandidateFeed'
import { BotLogsPanel } from '@/components/dashboard/BotLogsPanel'
import { PnlChart } from '@/components/dashboard/PnlChart'
import { DashboardRefresher } from '@/components/dashboard/DashboardRefresher'
import { createServerClient } from '@/lib/supabase'
import type { Candidate } from '@/lib/types'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = createServerClient()

  const [positionsRes, candidatesRes, logsRes, closedRes] = await Promise.allSettled([
    supabase
      .from('positions')
      .select('*')
      .in('status', ['active', 'out_of_range'])
      .order('opened_at', { ascending: false }),
    supabase
      .from('candidates')
      .select('*')
      .order('scanned_at', { ascending: false })
      .limit(20),
    supabase
      .from('bot_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30),
    supabase
      .from('positions')
      .select('sol_deposited, fees_earned_sol, status')
      .eq('status', 'closed'),
  ])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positions: any[] =
    positionsRes.status === 'fulfilled' ? (positionsRes.value.data ?? []) : []
  const candidates: Candidate[] =
    candidatesRes.status === 'fulfilled' ? (candidatesRes.value.data ?? []) : []
  const logs =
    logsRes.status === 'fulfilled' ? (logsRes.value.data ?? []) : []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closed: any[] =
    closedRes.status === 'fulfilled' ? (closedRes.value.data ?? []) : []

  const solDeployed    = positions.reduce((acc: number, p: any) => acc + (p.sol_deposited ?? 0), 0)
  const feesEarned24h  = positions.reduce((acc: number, p: any) => acc + (p.fees_earned_sol ?? 0), 0)
  const totalClosed    = closed.length
  const wins           = closed.filter((p: any) => (p.fees_earned_sol ?? 0) > 0).length
  const winRate        = totalClosed > 0 ? Math.round((wins / totalClosed) * 100) : null

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Auto-refreshes the full page every 30s */}
      <DashboardRefresher intervalMs={30_000} />
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          <KPIBar
            solDeployed={solDeployed}
            activePositions={positions.length}
            feesEarned24h={feesEarned24h}
            winRate={winRate}
            candidatesScanned={candidates.length}
          />
          {/* Live PNL chart — client component, auto-refreshes every 30s */}
          <PnlChart />
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2 space-y-6">
              <PositionsTable positions={positions} />
              <BotLogsPanel logs={logs} />
            </div>
            <div>
              <CandidateFeed candidates={candidates} />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
