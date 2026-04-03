'use client'

import { useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  Legend,
} from 'recharts'

interface PositionPnl {
  id: string
  symbol: string
  strategy: string
  currentPrice: number
  pricePct: number
  feesSol: number
  ilPct: number
  pnlSol: number
  status: string
}

interface PnlSnapshot {
  positions: PositionPnl[]
  totalPnlSol: number
  totalFeesSol: number
  cachedAt: string
}

// Recharts Formatter has a known type variance issue — cast to any is the accepted workaround
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tooltipFormatter(value: any, name: any): [string, string] {
  const n = String(name ?? '')
  const v = typeof value === 'number' ? value : parseFloat(String(value ?? 0))
  return [
    n === 'il' ? `${v.toFixed(2)}%` : `${v.toFixed(6)} SOL`,
    n === 'pnl' ? 'PNL' : n === 'fees' ? 'Fees' : 'IL%',
  ]
}

export function PnlChart() {
  const [data, setData] = useState<PnlSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function fetchPnl() {
    try {
      const res = await fetch('/api/positions/pnl')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: PnlSnapshot = await res.json()
      setData(json)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPnl()
    const interval = setInterval(fetchPnl, 30_000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return <div className="rounded-xl bg-zinc-900 p-4 text-zinc-400 text-sm">Loading PNL…</div>
  if (error)   return <div className="rounded-xl bg-zinc-900 p-4 text-red-400 text-sm">PNL error: {error}</div>
  if (!data || !data.positions.length) return <div className="rounded-xl bg-zinc-900 p-4 text-zinc-500 text-sm">No active positions</div>

  const chartData = data.positions.map((p) => ({
    name: p.symbol,
    pnl: p.pnlSol,
    fees: p.feesSol,
    il: Math.abs(p.ilPct),
  }))

  return (
    <div className="rounded-xl bg-zinc-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">Live PNL</h2>
        <div className="flex gap-4 text-xs text-zinc-400">
          <span>Total PNL: <span className={data.totalPnlSol >= 0 ? 'text-green-400' : 'text-red-400'}>{data.totalPnlSol.toFixed(4)} SOL</span></span>
          <span>Fees: <span className="text-yellow-400">{data.totalFeesSol.toFixed(4)} SOL</span></span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chartData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
          <XAxis dataKey="name" tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
            labelStyle={{ color: '#e4e4e7' }}
            formatter={tooltipFormatter as never}
          />
          <Legend formatter={(v) => v === 'pnl' ? 'PNL (SOL)' : v === 'fees' ? 'Fees (SOL)' : 'IL%'} />
          <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={entry.pnl >= 0 ? '#4ade80' : '#f87171'} />
            ))}
          </Bar>
          <Bar dataKey="fees" fill="#facc15" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {data.positions.map((p) => (
          <div key={p.id} className="rounded-lg bg-zinc-800 p-2 text-xs space-y-0.5">
            <div className="font-semibold text-zinc-100 truncate">{p.symbol}</div>
            <div className="text-zinc-400">{p.strategy}</div>
            <div className={p.pnlSol >= 0 ? 'text-green-400' : 'text-red-400'}>PNL: {p.pnlSol.toFixed(4)} SOL</div>
            <div className="text-yellow-400">Fees: {p.feesSol.toFixed(6)} SOL</div>
            <div className="text-orange-400">IL: {p.ilPct.toFixed(2)}%</div>
          </div>
        ))}
      </div>

      <div className="text-right text-xs text-zinc-600">Updated {new Date(data.cachedAt).toLocaleTimeString()}</div>
    </div>
  )
}
