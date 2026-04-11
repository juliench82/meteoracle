import { createServerClient } from '@/lib/supabase'
import { SpotKPIBar } from '@/components/dashboard/SpotKPIBar'
import { SpotPositionsTable } from '@/components/dashboard/SpotPositionsTable'
import { WatchlistFeed } from '@/components/dashboard/WatchlistFeed'
import { SpotPnlChart } from '@/components/dashboard/SpotPnlChart'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = createServerClient()

  const [openSpotRes, closedSpotRes, openLpRes, watchlistRes] = await Promise.allSettled([
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
      .from('positions')
      .select('*')
      .in('status', ['active', 'out_of_range'])
      .order('opened_at', { ascending: false }),
    supabase
      .from('pre_grad_watchlist')
      .select('*')
      .order('detected_at', { ascending: false })
      .limit(20),
  ])

  const openSpot    = openSpotRes.status    === 'fulfilled' ? (openSpotRes.value.data    ?? []) : []
  const closedSpot  = closedSpotRes.status  === 'fulfilled' ? (closedSpotRes.value.data  ?? []) : []
  const openLp      = openLpRes.status      === 'fulfilled' ? (openLpRes.value.data      ?? []) : []
  const watchlist   = watchlistRes.status   === 'fulfilled' ? (watchlistRes.value.data   ?? []) : []

  // Normalise LP positions into the SpotPosition shape expected by SpotPositionsTable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openLpNorm = openLp.map((p: any) => ({
    id:              p.id,
    mint:            p.token_address ?? '',
    symbol:          p.token_symbol  ?? 'LP',
    entry_price_usd: p.entry_price   ?? 0,
    amount_sol:      p.sol_deposited ?? 0,
    token_amount:    0,
    tp_pct:          0,
    sl_pct:          0,
    status:          'open',
    dry_run:         p.metadata?.sig === 'dry-run-sig',
    opened_at:       p.opened_at,
    closed_at:       p.closed_at ?? null,
    pnl_sol:         p.pnl_sol   ?? null,
    tx_buy:          p.metadata?.sig !== 'dry-run-sig' ? p.metadata?.sig : undefined,
    tx_sell:         undefined,
  }))

  const allOpen = [...openSpot, ...openLpNorm]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const solDeployed = allOpen.reduce((s: number, p: any) => s + (p.amount_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalPnl    = closedSpot.reduce((s: number, p: any) => s + (p.pnl_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wins        = closedSpot.filter((p: any) => (p.pnl_sol ?? 0) > 0).length
  const winRate     = closedSpot.length > 0
    ? Math.round((wins / closedSpot.length) * 100)
    : null

  return (
    <div className="p-6 space-y-6">
      <SpotKPIBar
        solDeployed={solDeployed}
        openPositions={allOpen.length}
        totalPnlSol={totalPnl}
        winRate={winRate}
        totalTrades={closedSpot.length}
        watchlistCount={watchlist.length}
      />
      <SpotPnlChart closedPositions={closedSpot} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <SpotPositionsTable
            openPositions={allOpen}
            closedPositions={closedSpot.slice(0, 20)}
          />
        </div>
        <div>
          <WatchlistFeed watchlist={watchlist} />
        </div>
      </div>
    </div>
  )
}
