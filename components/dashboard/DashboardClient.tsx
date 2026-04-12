'use client'

import { useEffect, useState, useCallback } from 'react'
import { SpotKPIBar } from '@/components/dashboard/SpotKPIBar'
import { SpotPositionsTable } from '@/components/dashboard/SpotPositionsTable'
import { WatchlistFeed } from '@/components/dashboard/WatchlistFeed'
import { SpotPnlChart } from '@/components/dashboard/SpotPnlChart'

const POLL_INTERVAL_MS = 30_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normaliseLp(p: any, closed = false) {
  return {
    id:              p.id,
    mint:            p.mint            ?? '',
    symbol:          p.symbol          ?? 'LP',
    entry_price_usd: p.entry_price_usd ?? 0,
    amount_sol:      p.sol_deposited   ?? 0,
    token_amount:    p.token_amount    ?? 0,
    tp_pct:          0,
    sl_pct:          0,
    status:          closed ? (p.close_reason ?? 'closed') : 'open',
    dry_run:         p.dry_run         ?? true,
    opened_at:       p.opened_at,
    closed_at:       p.closed_at       ?? null,
    pnl_sol:         p.pnl_sol         ?? null,
    tx_buy:          p.tx_open         ?? undefined,
    tx_sell:         p.tx_close        ?? undefined,
    _type:           'lp',
  }
}

interface InitialData {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openSpot:   any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  closedSpot: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  openLp:     any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  closedLp:   any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  watchlist:  any[]
}

export function DashboardClient({ initialData }: { initialData: InitialData }) {
  const [data, setData]         = useState(initialData)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [loading, setLoading]   = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/dashboard-data', { cache: 'no-store' })
      if (!res.ok) return
      const json = await res.json()
      setData(json)
      setLastUpdate(new Date())
    } catch {
      // keep stale data on error
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(fetchData, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchData])

  const openLpNorm   = data.openLp.map((p) => normaliseLp(p, false))
  const closedLpNorm = data.closedLp.map((p) => normaliseLp(p, true))

  const allOpen = [...data.openSpot, ...openLpNorm]
  const allClosed = [...data.closedSpot, ...closedLpNorm]
    .sort((a, b) => new Date(b.closed_at ?? 0).getTime() - new Date(a.closed_at ?? 0).getTime())
    .slice(0, 50)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const solDeployed = allOpen.reduce((s: number, p: any) => s + (p.amount_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const totalPnl    = allClosed.reduce((s: number, p: any) => s + (p.pnl_sol ?? 0), 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wins        = allClosed.filter((p: any) => (p.pnl_sol ?? 0) > 0).length
  const winRate     = allClosed.length > 0 ? Math.round((wins / allClosed.length) * 100) : null

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-500">
          Last updated: {lastUpdate.toLocaleTimeString()}
          {loading && <span className="ml-2 text-yellow-400">refreshing…</span>}
        </span>
        <button
          onClick={fetchData}
          className="text-xs text-zinc-400 hover:text-white border border-zinc-700 rounded px-2 py-0.5"
        >
          ↻ Refresh
        </button>
      </div>
      <SpotKPIBar
        solDeployed={solDeployed}
        openPositions={allOpen.length}
        totalPnlSol={totalPnl}
        winRate={winRate}
        totalTrades={allClosed.length}
        watchlistCount={data.watchlist.length}
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
          <WatchlistFeed watchlist={data.watchlist} />
        </div>
      </div>
    </div>
  )
}
