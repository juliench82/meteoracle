'use client'

import { useMemo } from 'react'

interface ClosedPosition {
  closed_at?: string
  pnl_sol?:   number
  symbol:     string
  status:     string
}

interface Props {
  closedPositions: ClosedPosition[]
}

export function SpotPnlChart({ closedPositions }: Props) {
  // Build cumulative P&L series sorted by close time
  const series = useMemo(() => {
    const sorted = [...closedPositions]
      .filter(p => p.closed_at)
      .sort((a, b) => new Date(a.closed_at!).getTime() - new Date(b.closed_at!).getTime())

    let cumulative = 0
    return sorted.map(p => {
      cumulative += p.pnl_sol ?? 0
      return {
        label:      new Date(p.closed_at!).toLocaleDateString(),
        pnl:        p.pnl_sol ?? 0,
        cumulative: parseFloat(cumulative.toFixed(5)),
        symbol:     p.symbol,
        isWin:      (p.pnl_sol ?? 0) > 0,
      }
    })
  }, [closedPositions])

  if (series.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex items-center justify-center h-32">
        <p className="text-zinc-500 text-sm">P&L chart will appear after first closed trade</p>
      </div>
    )
  }

  // Simple SVG sparkline — no external deps, works on Vercel Hobby
  const W = 600, H = 80, PAD = 8
  const values   = series.map(s => s.cumulative)
  const minVal   = Math.min(0, ...values)
  const maxVal   = Math.max(0, ...values)
  const range    = maxVal - minVal || 1
  const toY      = (v: number) => PAD + (1 - (v - minVal) / range) * (H - PAD * 2)
  const toX      = (i: number) => PAD + (i / Math.max(series.length - 1, 1)) * (W - PAD * 2)
  const zeroY    = toY(0)

  const pathD = series
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(s.cumulative).toFixed(1)}`)
    .join(' ')

  const lastVal  = values[values.length - 1]
  const pnlColor = lastVal >= 0 ? '#4ade80' : '#f87171'

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-white">Cumulative P&L</h3>
        <span className={`text-sm font-bold ${lastVal >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          {lastVal >= 0 ? '+' : ''}{lastVal.toFixed(4)} SOL
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 80 }}>
        {/* Zero line */}
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#3f3f46" strokeWidth="1" strokeDasharray="4" />
        {/* P&L line */}
        <path d={pathD} fill="none" stroke={pnlColor} strokeWidth="2" strokeLinejoin="round" />
        {/* Dots */}
        {series.map((s, i) => (
          <circle
            key={i}
            cx={toX(i)}
            cy={toY(s.cumulative)}
            r="3"
            fill={s.isWin ? '#4ade80' : '#f87171'}
          />
        ))}
      </svg>
      <div className="flex justify-between text-xs text-zinc-500 mt-1">
        <span>{series[0]?.label}</span>
        <span>{series.length} trades</span>
        <span>{series[series.length - 1]?.label}</span>
      </div>
    </div>
  )
}
