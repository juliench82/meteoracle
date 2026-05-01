import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const STRATEGY_LABELS: Record<string, string> = {
  'evil-panda': 'Evil Panda',
  'scalp-spike': 'Scalp Spike',
  'stable-farm': 'Stable Farm',
  'damm-edge': 'DAMM Edge',
}

function formatAge(openedAt: string): string {
  const ms = Date.now() - new Date(openedAt).getTime()
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

function fmtUsd(val: unknown): string {
  const n = Number(val)
  if (!val || isNaN(n)) return '—'
  return `$${n.toFixed(2)}`
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
                {['Token', 'Strategy', 'Deployed', 'Claimable $', 'Value $', 'Range', 'Age', 'Max Duration'].map(
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
                const claimableFeesUsd = p.metadata?.claimable_fees_usd
                const positionValueUsd = p.metadata?.position_value_usd

                return (
                  <tr
                    key={p.id}
                    className="border-b border-surface-border/50 hover:bg-surface-border/30 transition-colors"
                  >
                    {/* Token */}
                    <td className="py-3 pr-4 font-mono font-semibold text-white">
                      {p.token_symbol ?? p.symbol}
                    </td>

                    {/* Strategy */}
                    <td className="py-3 pr-4">
                      <Badge variant="brand">
                        {STRATEGY_LABELS[p.strategy_id] ?? p.strategy_id}
                      </Badge>
                    </td>

                    {/* Deployed */}
                    <td className="py-3 pr-4 font-mono text-slate-400">
                      {deployedSol.toFixed(4)} SOL
                    </td>

                    {/* Claimable fees — live from Meteora API */}
                    <td className="py-3 pr-4 font-mono text-yellow-400 tabular-nums">
                      {fmtUsd(claimableFeesUsd)}
                    </td>

                    {/* Position value — live from Meteora API */}
                    <td className="py-3 pr-4 font-mono text-slate-300 tabular-nums">
                      {fmtUsd(positionValueUsd)}
                    </td>

                    {/* Range status */}
                    <td className="py-3 pr-4">
                      <Badge variant={p.in_range ? 'success' : 'danger'}>
                        {p.in_range ? '✓ In range' : '✗ OOR'}
                      </Badge>
                    </td>

                    {/* Age */}
                    <td className="py-3 pr-4 text-slate-500">{formatAge(p.opened_at)}</td>

                    {/* Max duration */}
                    <td className="py-3 text-slate-500 font-mono">
                      {p.metadata?.maxDurationHours ?? '—'}h
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
