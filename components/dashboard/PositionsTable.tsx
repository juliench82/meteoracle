import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const STRATEGY_LABELS: Record<string, string> = {
  'evil-panda': 'Evil Panda',
  'scalp-spike': 'Scalp Spike',
  'stable-farm': 'Stable Farm',
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
                {['Token', 'Strategy', 'Entry', 'Current', 'Range', 'Fees', 'Deployed', 'Age'].map(
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
                const ageMs = Date.now() - new Date(p.opened_at).getTime()
                const ageLabel = ageMs < 3600000
                  ? `${Math.round(ageMs / 60000)}m`
                  : `${Math.round(ageMs / 3600000)}h`
                const entryPrice: number = p.entry_price ?? 0
                const currentPrice: number | null = p.current_price ?? null

                return (
                  <tr
                    key={p.id}
                    className="border-b border-surface-border/50 hover:bg-surface-border/30 transition-colors"
                  >
                    <td className="py-3 pr-4 font-mono font-semibold text-white">
                      {p.token_symbol}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge variant="brand">
                        {STRATEGY_LABELS[p.strategy_id] ?? p.strategy_id}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 font-mono text-slate-400">
                      ${entryPrice.toFixed(7)}
                    </td>
                    <td className="py-3 pr-4 font-mono text-slate-300">
                      {currentPrice !== null ? `$${currentPrice.toFixed(7)}` : '—'}
                    </td>
                    <td className="py-3 pr-4">
                      <Badge variant={p.in_range ? 'success' : 'danger'}>
                        {p.in_range ? '✓ In range' : '✗ OOR'}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4 font-mono text-green-400">
                      +{(p.fees_earned_sol ?? 0).toFixed(4)} SOL
                    </td>
                    <td className="py-3 pr-4 font-mono text-slate-400">
                      {(p.sol_deposited ?? 0)} SOL
                    </td>
                    <td className="py-3 text-slate-500">{ageLabel}</td>
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
