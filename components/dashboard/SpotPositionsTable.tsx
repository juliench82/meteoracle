'use client'

import { useState } from 'react'

interface Position {
  id:                string
  mint:              string
  symbol:            string
  entry_price_usd:   number
  entry_price_sol:   number
  current_price_usd: number
  amount_sol:        number
  pnl_sol?:          number | null
  pnl_pct?:          number | null
  fees_earned_sol?:  number | null
  il_pct?:           number | null
  status:            string
  dry_run:           boolean
  opened_at:         string
  closed_at?:        string
  tx_buy?:           string
  tx_sell?:          string
  _type?:            string
}

interface Props {
  openPositions:   Position[]
  closedPositions: Position[]
}

export function SpotPositionsTable({ openPositions, closedPositions }: Props) {
  const [tab, setTab] = useState<'open' | 'closed'>('open')
  const rows = tab === 'open' ? openPositions : closedPositions

  function typeBadge(type: string | undefined) {
    const base = 'px-1.5 py-0.5 rounded text-xs font-medium mr-1'
    return type === 'lp'
      ? <span className={`${base} bg-purple-900 text-purple-300`}>LP</span>
      : <span className={`${base} bg-blue-900/50 text-blue-400`}>SPOT</span>
  }

  function statusBadge(status: string, dryRun: boolean) {
    const base = 'px-2 py-0.5 rounded-full text-xs font-medium'
    if (dryRun)                       return <span className={`${base} bg-yellow-900 text-yellow-300`}>DRY</span>
    if (status === 'open')            return <span className={`${base} bg-blue-900 text-blue-300`}>OPEN</span>
    if (status === 'active')          return <span className={`${base} bg-blue-900 text-blue-300`}>ACTIVE</span>
    if (status === 'out_of_range')    return <span className={`${base} bg-orange-900 text-orange-300`}>OOR</span>
    if (status === 'closed_tp')       return <span className={`${base} bg-green-900 text-green-300`}>TP ✅</span>
    if (status === 'closed_sl')       return <span className={`${base} bg-red-900 text-red-300`}>SL ❌</span>
    if (status === 'closed_manual')   return <span className={`${base} bg-zinc-700 text-zinc-300`}>MANUAL</span>
    if (status === 'closed_timeout')  return <span className={`${base} bg-zinc-700 text-zinc-300`}>TIMEOUT</span>
    if (status === 'emergency_stop')  return <span className={`${base} bg-red-900 text-red-300`}>STOP</span>
    return <span className={`${base} bg-zinc-800 text-zinc-400`}>{status}</span>
  }

  function entryCell(pos: Position) {
    if (pos.entry_price_usd > 0)
      return <span>${pos.entry_price_usd.toExponential(3)}</span>
    if (pos.entry_price_sol > 0)
      return <span className="text-zinc-400">{pos.entry_price_sol.toExponential(3)} SOL</span>
    return <span className="text-zinc-500">—</span>
  }

  function pnlCells(pos: Position) {
    const isLp = pos._type === 'lp'

    if (!isLp) {
      // Spot: single P&L column spanning fees + IL + total
      if (pos.pnl_pct !== undefined && pos.pnl_pct !== null) {
        const color = pos.pnl_pct >= 0 ? 'text-green-400' : 'text-red-400'
        return (
          <>
            <td className="text-right px-4 py-3 text-zinc-500">—</td>
            <td className="text-right px-4 py-3 text-zinc-500">—</td>
            <td className="text-right px-4 py-3">
              <span className={color}>{pos.pnl_pct >= 0 ? '+' : ''}{pos.pnl_pct.toFixed(1)}%</span>
            </td>
          </>
        )
      }
      if (pos.pnl_sol !== undefined && pos.pnl_sol !== null) {
        const color = pos.pnl_sol >= 0 ? 'text-green-400' : 'text-red-400'
        return (
          <>
            <td className="text-right px-4 py-3 text-zinc-500">—</td>
            <td className="text-right px-4 py-3 text-zinc-500">—</td>
            <td className="text-right px-4 py-3">
              <span className={color}>{pos.pnl_sol >= 0 ? '+' : ''}{pos.pnl_sol.toFixed(4)}</span>
              <div className="text-xs text-zinc-500">SOL</div>
            </td>
          </>
        )
      }
      return (
        <>
          <td className="text-right px-4 py-3 text-zinc-500">—</td>
          <td className="text-right px-4 py-3 text-zinc-500">—</td>
          <td className="text-right px-4 py-3 text-zinc-500">—</td>
        </>
      )
    }

    // LP: Fees | IL | PnL (SOL)
    const fees     = pos.fees_earned_sol ?? 0
    const deployed = pos.amount_sol ?? 0
    const ilPct    = pos.il_pct ?? null
    const total    = pos.pnl_sol ?? null

    const feesColor  = fees > 0 ? 'text-emerald-400' : 'text-zinc-500'
    const ilColor    = ilPct !== null ? (ilPct >= 0 ? 'text-zinc-400' : 'text-red-400') : 'text-zinc-500'
    const totalColor = total !== null ? (total >= 0 ? 'text-green-400' : 'text-red-400') : 'text-zinc-500'

    const feeYield = deployed > 0 ? (fees / deployed) * 100 : 0
    const totalPct = total !== null && deployed > 0 ? (total / deployed) * 100 : null

    return (
      <>
        {/* Fees Earned */}
        <td className="text-right px-4 py-3">
          <span className={feesColor}>
            {fees > 0 ? `+${fees.toFixed(4)}` : '—'}
          </span>
          {feeYield > 0 && (
            <div className="text-xs text-zinc-500">{feeYield.toFixed(1)}%</div>
          )}
        </td>
        {/* IL */}
        <td className="text-right px-4 py-3">
          {ilPct !== null
            ? <span className={ilColor}>IL {ilPct >= 0 ? '+' : ''}{ilPct.toFixed(1)}%</span>
            : <span className="text-zinc-500">—</span>
          }
        </td>
        {/* PnL (SOL) */}
        <td className="text-right px-4 py-3">
          {total !== null ? (
            <>
              <span className={totalColor}>{total >= 0 ? '+' : ''}{total.toFixed(4)}</span>
              {totalPct !== null && (
                <div className="text-xs text-zinc-500">{totalPct >= 0 ? '+' : ''}{totalPct.toFixed(1)}%</div>
              )}
            </>
          ) : (
            <span className="text-zinc-500">—</span>
          )}
        </td>
      </>
    )
  }

  function age(openedAt: string) {
    const mins = (Date.now() - new Date(openedAt).getTime()) / 60_000
    if (mins < 60)   return `${Math.round(mins)}m`
    if (mins < 1440) return `${Math.round(mins / 60)}h`
    return `${Math.round(mins / 1440)}d`
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
      <div className="flex border-b border-zinc-800">
        {(['open', 'closed'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'text-white border-b-2 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t === 'open'
              ? `Open (${openPositions.length})`
              : `Closed (${closedPositions.length})`}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        {rows.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-10">
            {tab === 'open' ? 'No open positions' : 'No closed trades yet'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-zinc-500 text-xs uppercase border-b border-zinc-800">
                <th className="text-left px-4 py-3">Token</th>
                <th className="text-right px-4 py-3">Size</th>
                <th className="text-right px-4 py-3">Entry</th>
                <th className="text-right px-4 py-3">Fees</th>
                <th className="text-right px-4 py-3">IL</th>
                <th className="text-right px-4 py-3">PnL (SOL)</th>
                <th className="text-right px-4 py-3">Age</th>
                <th className="text-center px-4 py-3">Status</th>
                <th className="text-center px-4 py-3">Tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(pos => (
                <tr key={pos.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {typeBadge(pos._type)}
                      <span className="font-medium text-white">{pos.symbol}</span>
                    </div>
                    <div className="text-zinc-500 text-xs mt-0.5">{pos.mint?.slice(0, 8)}...</div>
                  </td>
                  <td className="text-right px-4 py-3 text-zinc-300">
                    {pos.amount_sol.toFixed(3)} SOL
                  </td>
                  <td className="text-right px-4 py-3 text-zinc-300">
                    {entryCell(pos)}
                  </td>
                  {pnlCells(pos)}
                  <td className="text-right px-4 py-3 text-zinc-400">
                    {age(pos.opened_at)}
                  </td>
                  <td className="text-center px-4 py-3">
                    {statusBadge(pos.status, pos.dry_run)}
                  </td>
                  <td className="text-center px-4 py-3 space-x-2">
                    {pos.tx_buy && (
                      <a href={`https://solscan.io/tx/${pos.tx_buy}`} target="_blank" rel="noreferrer"
                        className="text-blue-400 hover:underline text-xs">buy</a>
                    )}
                    {pos.tx_sell && (
                      <a href={`https://solscan.io/tx/${pos.tx_sell}`} target="_blank" rel="noreferrer"
                        className="text-purple-400 hover:underline text-xs">sell</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
