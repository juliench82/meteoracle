import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const STRATEGY_LABELS: Record<string, string> = {
  'evil-panda': 'Evil Panda',
  'scalp-spike': 'Scalp Spike',
  'stable-farm': 'Stable Farm',
}

function formatAge(openedAt: string): string {
  const ms = Date.now() - new Date(openedAt).getTime()
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function PositionsTable({ positions }: { positions: any[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">Open Positions</h2>
        <Badge variant="neutral">{positions.length} active</Badge>
      </div>

      {positions.length === 0 ? (
        <p className="text-slate-600 text-sm py-8 text-center">No open positions</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-surface-border">
                {['Token', 'Strategy', 'Deployed', 'Fees Earned', 'Price PnL', 'Total Return', 'Range', 'Age', 'Duration'].map(
                  (h) => (
                    <th key={h} className="text-left py-2 pr-4 font-medium">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const deployedSol: number = p.sol_deposited ?? 0
                const feesEarnedSol: number = p.fees_earned_sol ?? 0
                const feeYieldPct = deployedSol > 0 ? (feesEarnedSol / deployedSol) * 100 : 0
                // Price PnL = total pnl_sol minus fees (pure price movement component)
                const pricePnlSol: number = (p.pnl_sol ?? 0) - feesEarnedSol
                const totalReturn: number = (p.pnl_sol ?? 0)
                const feeExtensions: number = p.metadata?.feeYieldExtensions ?? 0
                const effectiveMax: number | undefined = p.metadata?.effectiveMaxDurationHours

                return (
                  <tr
                    key={p.id}
                    className="border-b border-surface-border/50 hover:bg-surface-border/30 transition-colors"
                  >
                    {/* Token + symbol */}
                    <td className="py-3 pr-4 font-mono font-semibold text-white">
                      {p.token_symbol ?? p.symbol}
                    </td>

                    {/* Strategy + extended badge */}
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge variant="brand">
                          {STRATEGY_LABELS[p.strategy_id] ?? p.strategy_id}
                        </Badge>
                        {feeExtensions > 0 && (
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/60 text-emerald-300 border border-emerald-700/50"
                            title={effectiveMax ? `Effective max duration: ${effectiveMax}h` : `Extended ${feeExtensions}× by fee yield`}
                          >
                            🚀 +{feeExtensions}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Deployed */}
                    <td className="py-3 pr-4 font-mono text-slate-400">
                      {deployedSol.toFixed(4)} SOL
                    </td>

                    {/* Fees Earned + % of deployed */}
                    <td className="py-3 pr-4">
                      <div className="font-mono text-yellow-400">
                        +{feesEarnedSol.toFixed(4)} SOL
                      </div>
                      {deployedSol > 0 && (
                        <div className="text-slate-500 tabular-nums">
                          {feeYieldPct.toFixed(1)}% deployed
                        </div>
                      )}
                    </td>

                    {/* Price PnL (excludes fees) */}
                    <td className={`py-3 pr-4 font-mono tabular-nums ${
                      pricePnlSol >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {pricePnlSol >= 0 ? '+' : ''}{pricePnlSol.toFixed(4)} SOL
                      {p.il_pct != null && (
                        <div className="text-slate-500 font-normal">
                          {p.il_pct.toFixed(2)}% IL
                        </div>
                      )}
                    </td>

                    {/* Total Return = pnl_sol (price movement + fees) */}
                    <td className={`py-3 pr-4 font-mono font-semibold tabular-nums ${
                      totalReturn >= 0 ? 'text-green-300' : 'text-red-400'
                    }`}>
                      {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(4)} SOL
                    </td>

                    {/* Range status */}
                    <td className="py-3 pr-4">
                      <Badge variant={p.in_range ? 'success' : 'danger'}>
                        {p.in_range ? '✓ In range' : '✗ OOR'}
                      </Badge>
                    </td>

                    {/* Age */}
                    <td className="py-3 pr-4 text-slate-500">{formatAge(p.opened_at)}</td>

                    {/* Max duration (extended = teal) */}
                    <td className="py-3 text-slate-500">
                      {effectiveMax ? (
                        <span className="text-emerald-400 font-mono" title="Extended by fee yield">
                          {effectiveMax}h ✦
                        </span>
                      ) : (
                        <span className="font-mono">
                          {p.metadata?.maxDurationHours ?? '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
