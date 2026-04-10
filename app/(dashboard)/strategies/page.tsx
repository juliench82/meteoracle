import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '@/strategies/pre-grad'

export const dynamic = 'force-dynamic'

export default async function StrategiesPage() {
  const supabase = createServerClient()
  const cfg = PRE_GRAD_STRATEGY

  const { data: closed } = await supabase
    .from('spot_positions')
    .select('pnl_sol, status, dry_run, opened_at, closed_at, amount_sol')
    .in('status', ['closed_tp', 'closed_sl'])

  const rows     = closed ?? []
  const wins     = rows.filter(r => (r.pnl_sol ?? 0) > 0).length
  const losses   = rows.length - wins
  const totalPnl = rows.reduce((s, r) => s + (r.pnl_sol ?? 0), 0)
  const winRate  = rows.length > 0 ? Math.round((wins / rows.length) * 100) : null
  const avgWin   = wins > 0
    ? rows.filter(r => (r.pnl_sol ?? 0) > 0).reduce((s, r) => s + (r.pnl_sol ?? 0), 0) / wins
    : 0
  const avgLoss  = losses > 0
    ? rows.filter(r => (r.pnl_sol ?? 0) <= 0).reduce((s, r) => s + (r.pnl_sol ?? 0), 0) / losses
    : 0
  const avgHoldMin = rows.filter(r => r.closed_at).reduce((s, r) => {
    return s + (new Date(r.closed_at!).getTime() - new Date(r.opened_at).getTime()) / 60_000
  }, 0) / (rows.length || 1)

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Strategies</h1>
        <p className="text-sm text-zinc-500 mt-1">Active strategy configs and performance</p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">pre-grad</h2>
            <p className="text-sm text-zinc-500">Pre-graduation pump.fun spot buys</p>
          </div>
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-green-900 text-green-300">ACTIVE</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Buy Size',      value: `${cfg.position.spotBuySol} SOL` },
            { label: 'Max Positions', value: String(cfg.position.maxConcurrentSpots) },
            { label: 'Max Capital',   value: `${cfg.position.maxTotalSpotSol} SOL` },
            { label: 'Min Volume',    value: `${cfg.scanner.minVolume5minSol} SOL` },
            { label: 'Take Profit',   value: `+${cfg.exits.takeProfitPct}%` },
            { label: 'Stop Loss',     value: `${cfg.exits.stopLossPct}%` },
            { label: 'Max Hold',      value: `${cfg.exits.maxHoldMinutes}min` },
            { label: 'Bonding Range', value: `${cfg.scanner.minBondingProgress}–${cfg.scanner.maxBondingProgress}%` },
          ].map(({ label, value }) => (
            <div key={label} className="bg-zinc-800 rounded-lg p-3">
              <p className="text-xs text-zinc-500 mb-1">{label}</p>
              <p className="text-sm font-semibold text-white">{value}</p>
            </div>
          ))}
        </div>

        <div>
          <h3 className="text-sm font-medium text-zinc-400 mb-3">Performance (all time)</h3>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
            {[
              { label: 'Trades',    value: String(rows.length),                                       color: 'text-white' },
              { label: 'Win Rate',  value: winRate !== null ? `${winRate}%` : '—',                    color: winRate !== null && winRate >= 50 ? 'text-green-400' : 'text-yellow-400' },
              { label: 'Total PnL', value: `${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL`,   color: totalPnl >= 0 ? 'text-green-400' : 'text-red-400' },
              { label: 'Avg Win',   value: wins > 0 ? `+${avgWin.toFixed(4)} SOL` : '—',             color: 'text-green-400' },
              { label: 'Avg Loss',  value: losses > 0 ? `${avgLoss.toFixed(4)} SOL` : '—',           color: 'text-red-400' },
              { label: 'Avg Hold',  value: rows.length > 0 ? `${Math.round(avgHoldMin)}min` : '—',   color: 'text-zinc-300' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-500 mb-1">{label}</p>
                <p className={`text-sm font-bold ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-dashed border-zinc-700 rounded-xl p-6 text-center">
        <p className="text-zinc-500 text-sm">More strategies coming — post-grad LP (Day 7)</p>
      </div>
    </div>
  )
}
