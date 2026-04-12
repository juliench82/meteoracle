import { createServerClient } from '@/lib/supabase'
import { SpotKPIBar } from '@/components/dashboard/SpotKPIBar'
import { SpotPositionsTable } from '@/components/dashboard/SpotPositionsTable'
import { WatchlistFeed } from '@/components/dashboard/WatchlistFeed'
import { SpotPnlChart } from '@/components/dashboard/SpotPnlChart'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const supabase = createServerClient()

  const [openSpotRes, closedSpotRes, openLpRes, closedLpRes, watchlistRes] = await Promise.allSettled([
    // Open spot positions
    supabase
      .from('spot_positions')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: false }),

    // Closed spot positions — all close reasons
    supabase
      .from('spot_positions')
      .select('*')
      .in('status', ['closed_tp', 'closed_sl', 'closed_manual', 'closed_timeout'])
      .order('closed_at', { ascending: false })
      .limit(50),

    // Open LP positions
    supabase
      .from('lp_positions')
      .select('*')
      .in('status', ['active', 'out_of_range'])
      .order('opened_at', { ascending: false }),

    // Closed LP positions
    supabase
      .from('lp_positions')
      .select('*')
      .eq('status', 'closed')
      .order('closed_at', { ascending: false })
      .limit(50),

    // Watchlist
    supabase
      .from('pre_grad_watchlist')
      .select('*')
      .order('detected_at', { ascending: false })
      .limit(20),
  ])

  const openSpot  = openSpotRes.status   === 'fulfilled' ? (openSpotRes.value.data   ?? []) : []
  const closedSpot = closedSpotRes.status === 'fulfilled' ? (closedSpotRes.value.data ?? []) : []
  const openLp    = openLpRes.status     === 'fulfilled' ? (openLpRes.value.data     ?? []) : []
  const closedLp  = closedLpRes.status   === 'fulfilled' ? (closedLpRes.value.data   ?? []) : []
  const watchlist = watchlistRes.status  === 'fulfilled' ? (watchlistRes.value.data  ?? []) : []

  // Normalise open LP positions to match the spot_positions shape used by SpotPositionsTable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openLpNorm = openLp.map((p: any) => ({
    id:              p.id,
    mint:            p.mint           ?? '',       // correct column
    symbol:          p.symbol         ?? 'LP',
    entry_price_usd: p.entry_price_usd ?? 0,       // correct column
    amount_sol:      p.sol_deposited  ?? 0,
    token_amount:    p.token_amount   ?? 0,
    tp_pct:          0,
    sl_pct:          0,
    status:          'open',
    dry_run:         p.dry_run        ?? true,     // direct boolean column
    opened_at:       p.opened_at,
    closed_at:       p.closed_at      ?? null,
    pnl_sol:         p.pnl_sol        ?? null,
    tx_buy:          p.tx_open        ?? undefined,
    tx_sell:         p.tx_close       ?? undefined,
    _type:           'lp',
  }))

  // Normalise closed LP positions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closedLpNorm = closedLp.map((p: any) => ({
    id:              p.id,
    mint:            p.mint           ?? '',
    symbol:          p.symbol         ?? 'LP',
    entry_price_usd: p.entry_price_usd ?? 0,
    amount_sol:      p.sol_deposited  ?? 0,
    token_amount:    p.token_amount   ?? 0,
    tp_pct:          0,
    sl_pct:          0,
    status:          p.close_reason   ?? 'closed',
    dry_run:         p.dry_run        ?? true,
    opened_at:       p.opened_at,
    closed_at:       p.closed_at      ?? null,
    pnl_sol:         p.pnl_sol        ?? null,
    tx_buy:          p.tx_open        ?? undefined,
    tx_sell:         p.tx_close       ?? undefined,
    _type:           'lp',
  }))

  const allOpen   = [...openSpot,   ...openLpNorm]
  const allClosed = [...closedSpot, ...closedLpNorm]
    .sort((a, b) => new Date(b.closed_at ?? 0).getTime() - new Date(a.closed_at ?? 0).getTime())
    .slice(0, 50)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const solDeployed = allOpen.reduce((s: number, p: any) => s + (p.amount_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalPnl    = allClosed.reduce((s: number, p: any) => s + (p.pnl_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wins        = allClosed.filter((p: any) => (p.pnl_sol ?? 0) > 0).length
  const winRate     = allClosed.length > 0
    ? Math.round((wins / allClosed.length) * 100)
    : null

  return (
    <div className="p-6 space-y-6">
      <SpotKPIBar
        solDeployed={solDeployed}
        openPositions={allOpen.length}
        totalPnlSol={totalPnl}
        winRate={winRate}
        totalTrades={allClosed.length}
        watchlistCount={watchlist.length}
      />
      <SpotPnlChart closedPositions={allClosed} />
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2">
          <SpotPositionsTable
            openPositions={allOpen}
            closedPositions={allClosed.slice(0, 20)}
          />
        </div>
        <div>
          <WatchlistFeed watchlist={watchlist} />
        </div>
      </div>
    </div>
  )
}
