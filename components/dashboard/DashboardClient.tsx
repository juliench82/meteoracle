'use client'

import { useEffect, useState, useCallback } from 'react'
import { SpotKPIBar } from '@/components/dashboard/SpotKPIBar'
import { SpotPositionsTable } from '@/components/dashboard/SpotPositionsTable'
import { MoonboyPanel } from '@/components/dashboard/MoonboyPanel'
import { RetroPnLChart } from '@/components/dashboard/RetroPnLChart'
import type { MoonboyLivePosition } from '@/lib/moonboy-live'

const POLL_INTERVAL_MS = 30_000

function normaliseLp(p: any, closed = false) {
  return {
    id:              p.id,
    mint:            p.mint            ?? '',
    symbol:          p.symbol          ?? 'LP',
    entry_price_usd: p.entry_price_usd ?? 0,
    entry_price_sol: p.entry_price_sol ?? 0,
    amount_sol:      p.sol_deposited   ?? 0,
    token_amount:    p.token_amount    ?? 0,
    claimable_fees_usd: p.claimable_fees_usd ?? null,
    position_value_usd: p.position_value_usd ?? null,
    pnl_usd:            p.pnl_usd            ?? null,
    realized_pnl_usd:   p.realized_pnl_usd   ?? null,
    deposits:           p.deposits           ?? p.metadata?.deposits ?? null,
    tp_pct:          0,
    sl_pct:          0,
    status:          closed ? (p.close_reason ?? 'closed') : (p.status ?? 'open'),
    dry_run:         p.dry_run         ?? true,
    opened_at:       p.opened_at,
    closed_at:       p.closed_at       ?? null,
    tx_buy:          p.tx_open         ?? undefined,
    tx_sell:         p.tx_close        ?? undefined,
    metadata:        p.metadata        ?? {},
    _type:           'lp',
  }
}

interface InitialData {
  openSpot:   any[]
  closedSpot: any[]
  openLp:     any[]
  closedLp:   any[]
  moonboy:    MoonboyLivePosition[]
  wallet?:    { sol?: number | null } | null
  portfolio?: any
  meteoraLive?: {
    ok?: boolean
    dlmmOk?: boolean
    dammOk?: boolean
    errors?: {
      dlmm?: string | null
      damm?: string | null
    }
    count?: number
  }
}

function shortLiveError(label: string, message?: string | null): string | null {
  if (!message) return null
  const cleaned = message
    .replace(/api-key=[^"'\s&]+/gi, 'api-key=redacted')
    .replace(/\s+/g, ' ')
    .trim()
  return `${label}: ${cleaned.slice(0, 180)}`
}

export function DashboardClient({ initialData }: { initialData: InitialData }) {
  const [data, setData]             = useState(initialData)
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [loading, setLoading]       = useState(false)

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
    fetchData()
    const id = setInterval(fetchData, POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchData])

  const openLpNorm   = data.openLp.map((p) => normaliseLp(p, false))
  const closedLpNorm = data.closedLp.map((p) => normaliseLp(p, true))

  const allOpen = [...data.openSpot, ...openLpNorm]
  const allClosed = [...data.closedSpot, ...closedLpNorm]
    .sort((a, b) => new Date(b.closed_at ?? 0).getTime() - new Date(a.closed_at ?? 0).getTime())
    .slice(0, 50)

  const solDeployed = allOpen.reduce((s: number, p: any) => s + (p.amount_sol ?? 0), 0)
  const liveWarning = data.meteoraLive && !data.meteoraLive.ok
  const liveErrors = [
    shortLiveError('DLMM', data.meteoraLive?.errors?.dlmm),
    shortLiveError('DAMM', data.meteoraLive?.errors?.damm),
  ].filter(Boolean)

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
      {liveWarning && (
        <div className="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          Meteora live fetch is incomplete: DLMM {data.meteoraLive?.dlmmOk ? 'ok' : 'failed'} / DAMM {data.meteoraLive?.dammOk ? 'ok' : 'failed'}. Showing any available cache rows until live data recovers.
          {liveErrors.length > 0 && (
            <div className="mt-1 text-xs text-amber-100/80">
              {liveErrors.join(' | ')}
            </div>
          )}
        </div>
      )}
      {/* Retro Section: Portfolio Overview */}
      <div className="mt-8 px-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-px flex-1 bg-gradient-to-r from-retro-pink to-transparent" />
          <pre className="font-mono text-[8px] leading-[7px] text-retro-pink opacity-90">
{`   /\\  
  /  \\ 
 /____\\`}
          </pre>
          <span className="font-mono text-xs tracking-[2px] text-retro-pink">PORTFOLIO // LIVE</span>
          <div className="h-px flex-1 bg-gradient-to-l from-retro-cyan to-transparent" />
        </div>
      </div>

      <div className="px-6">
        <SpotKPIBar
          solDeployed={solDeployed}
          openPositions={allOpen.length}
          totalTrades={allClosed.length}
          walletSol={data.wallet?.sol ?? null}
          portfolio={data.portfolio}
        />
      </div>

      {/* Positions */}
      <div className="mt-8 px-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-px flex-1 bg-gradient-to-r from-retro-cyan to-transparent" />
          <pre className="font-mono text-[8px] text-retro-cyan opacity-80 leading-[6px]">
{`  *  *  
 / \\ / \\ 
*   *   *`}
          </pre>
          <span className="font-mono text-xs tracking-[2px] text-retro-cyan">OPEN &amp; CLOSED POSITIONS</span>
          <div className="h-px flex-1 bg-gradient-to-l from-retro-pink to-transparent" />
        </div>
      </div>

      <div className="px-6">
        <SpotPositionsTable
          openPositions={allOpen}
          closedPositions={allClosed.slice(0, 20)}
        />
      </div>

      <div className="px-6 mt-8">
        <MoonboyPanel positions={data.moonboy ?? []} />
      </div>

      {/* Ultra Retro PnL Chart Section */}
      <div className="mt-8 px-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-px flex-1 bg-gradient-to-r from-retro-lime to-transparent" />
          <pre className="font-mono text-[9px] leading-[8px] text-retro-lime tracking-wider">
{`╔═══════════════╗
║ HIGH SCORE    ║
╚═══════════════╝`}
          </pre>
          <span className="font-mono text-xs tracking-[2px] text-retro-lime">PERFORMANCE LOG</span>
          <div className="h-px flex-1 bg-gradient-to-l from-retro-orange to-transparent" />
        </div>
      </div>

      <div className="px-6">
        <RetroPnLChart />
      </div>

      {/* Classic 2026 Arcade Status Bar — Maximum 80s Flair */}
      <div className="mt-10 border-t-2 border-retro-border bg-retro-surface py-2 px-6">
        <div className="flex items-center justify-between text-[10px] font-mono tracking-[1.5px] text-retro-text-dim">
          <div className="flex items-center gap-4">
            <span className="text-retro-lime">● SYSTEM ONLINE</span>
            <span className="text-retro-orange">2026</span>
            <span>METEORACLE v1.0</span>
          </div>

          {/* ASCII Art Meteor */}
          <pre className="font-mono text-[8px] leading-[6px] text-retro-pink opacity-80">
{`   *  
  / \\ 
 /   \\
*     *`}
          </pre>

          <div className="flex items-center gap-4">
            <span>SOL LIVE FEED: <span className="text-retro-cyan">ACTIVE</span></span>
            <span>CRT MODE: <span className="text-retro-pink">ENABLED</span></span>
          </div>

          <div className="text-retro-lime">
            READY PLAYER ONE
          </div>
        </div>
      </div>
    </div>
  )
}
