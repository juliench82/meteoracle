'use client'

import type { MoonboyLivePosition } from '@/lib/moonboy-live'

function pnlColor(pct: number | null): string {
  if (pct === null) return 'text-zinc-400'
  if (pct >= 0) return 'text-emerald-400'
  return 'text-red-400'
}

function formatPct(pct: number | null): string {
  if (pct === null) return '—'
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
}

function formatPrice(price: number | null): string {
  if (price === null) return '—'
  if (price < 0.000001) return price.toExponential(3)
  if (price < 0.01) return price.toFixed(7)
  return price.toFixed(4)
}

function ProgressBar({ pct, tp, sl }: { pct: number | null; tp: number | null; sl: number | null }) {
  if (pct === null || tp === null || sl === null) return null
  const range = tp - sl
  if (range <= 0) return null
  const filled = Math.min(Math.max(((pct - sl) / range) * 100, 0), 100)
  return (
    <div className="relative h-1.5 w-24 rounded-full bg-zinc-700 overflow-hidden">
      <div
        className={`absolute left-0 top-0 h-full rounded-full transition-all ${
          pct >= 0 ? 'bg-emerald-500' : 'bg-red-500'
        }`}
        style={{ width: `${filled}%` }}
      />
    </div>
  )
}

export function MoonboyPanel({ positions }: { positions: MoonboyLivePosition[] }) {
  if (!positions.length) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="text-sm font-semibold text-zinc-300 mb-3">🌙 Moonboy Positions</h2>
        <p className="text-xs text-zinc-500">No open moonboy positions.</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <h2 className="text-sm font-semibold text-zinc-300 mb-3">
        🌙 Moonboy Positions
        <span className="ml-2 text-xs text-zinc-500 font-normal">({positions.length} open · live Jupiter prices)</span>
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-zinc-500 border-b border-zinc-800">
              <th className="text-left pb-2 pr-4 font-medium">Token</th>
              <th className="text-right pb-2 pr-4 font-medium">Entry</th>
              <th className="text-right pb-2 pr-4 font-medium">Price</th>
              <th className="text-right pb-2 pr-4 font-medium">PnL %</th>
              <th className="text-left pb-2 pr-4 font-medium">TP / SL progress</th>
              <th className="text-right pb-2 pr-4 font-medium">SOL in</th>
              <th className="text-right pb-2 font-medium">Age</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => (
              <tr key={pos.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-zinc-100">{pos.symbol}</span>
                    {pos.dry_run && (
                      <span className="text-[10px] bg-zinc-700 text-zinc-300 rounded px-1">DRY</span>
                    )}
                  </div>
                  <div className="text-[10px] text-zinc-600 font-mono mt-0.5">
                    {pos.mint.slice(0, 8)}…
                  </div>
                </td>
                <td className="py-2 pr-4 text-right text-zinc-400 font-mono">
                  ${formatPrice(pos.entry_price_usd)}
                </td>
                <td className="py-2 pr-4 text-right font-mono text-zinc-200">
                  {pos.current_price_usd !== null ? `$${formatPrice(pos.current_price_usd)}` : '—'}
                </td>
                <td className={`py-2 pr-4 text-right font-mono font-semibold ${pnlColor(pos.pnl_pct)}`}>
                  {formatPct(pos.pnl_pct)}
                </td>
                <td className="py-2 pr-4">
                  <div className="flex flex-col gap-1">
                    <ProgressBar pct={pos.pnl_pct} tp={pos.take_profit_pct} sl={pos.stop_loss_pct} />
                    {pos.take_profit_pct !== null && pos.stop_loss_pct !== null && (
                      <span className="text-[10px] text-zinc-600">
                        SL {pos.stop_loss_pct}% / TP +{pos.take_profit_pct}%
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-4 text-right text-zinc-400 font-mono">
                  {pos.sol_spent.toFixed(3)}
                </td>
                <td className="py-2 text-right text-zinc-500">
                  {pos.age_hours < 1
                    ? `${Math.round(pos.age_hours * 60)}m`
                    : `${pos.age_hours.toFixed(1)}h`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
