'use client'

import { useState } from 'react'

interface Position {
  id:              string
  mint:            string
  symbol:          string
  entry_price_usd: number
  amount_sol:      number
  status:          string
  dry_run:         boolean
  opened_at:       string
  closed_at?:      string
  pnl_sol?:        number
  tx_buy?:         string
  tx_sell?:        string
  _type?:          string   // 'lp' | undefined (spot)
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

  function pnlCell(pnl: number | undefined) {
    if (pnl === undefined || pnl === null) return <span className="text-zinc-500">—</span>
    const color = pnl >= 0 ? 'text-green-400' : 'text-red-400'
    return <span className={color}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(4)} SOL</span>
  }

  function age(openedAt: string) {
    const mins = (Date.now() - new Date(openedAt).getTime()) / 60_000
    if (mins < 60)   return `${Math.round(mins)}m`
    if (mins < 1440) return `${Math.round(mins / 60)}h`
    return `${Math.round(mins / 1440)}d`
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
      {/* Tabs */}
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

      {/* Table */}
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
                <th className="text-right px-4 py-3">Entry $</th>
                <th className="text-right px-4 py-3">P&amp;L</th>
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
                    {pos.entry_price_usd > 0
                      ? `$${pos.entry_price_usd.toExponential(3)}`
                      : <span className="text-zinc-500">—</span>
                    }
                  </td>
                  <td className="text-right px-4 py-3">
                    {pnlCell(pos.pnl_sol)}
                  </td>
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
