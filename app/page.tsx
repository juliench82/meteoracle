import { Sidebar } from '@/components/layout/Sidebar'
import { Header } from '@/components/layout/Header'
import { KPIBar } from '@/components/dashboard/KPIBar'
import { PositionsTable } from '@/components/dashboard/PositionsTable'
import { CandidateFeed } from '@/components/dashboard/CandidateFeed'

export default function DashboardPage() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6 space-y-6">
          <KPIBar />
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              <PositionsTable />
            </div>
            <div>
              <CandidateFeed />
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
