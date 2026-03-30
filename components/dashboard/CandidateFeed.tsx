import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import type { Candidate } from '@/lib/types'

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-400'
  if (score >= 65) return 'text-brand-light'
  if (score >= 50) return 'text-yellow-400'
  return 'text-slate-500'
}

const STRATEGY_LABELS: Record<string, string> = {
  'evil-panda': 'Evil Panda',
  'scalp-spike': 'Scalp Spike',
  'stable-farm': 'Stable Farm',
}

export function CandidateFeed({ candidates }: { candidates: Candidate[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">Candidate Feed</h2>
        <Badge variant="neutral">{candidates.length}</Badge>
      </div>

      {candidates.length === 0 ? (
        <p className="text-slate-600 text-sm py-8 text-center">No candidates yet</p>
      ) : (
        <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
          {candidates.map((c) => {
            const age = Math.round(
              (Date.now() - new Date(c.scannedAt).getTime()) / 60000
            )
            return (
              <div
                key={c.id}
                className="flex items-center justify-between p-3 rounded-lg bg-surface border border-surface-border hover:border-brand/30 transition-colors"
              >
                <div>
                  <p className="text-sm font-mono font-semibold text-white">
                    {c.symbol}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Vol {formatNum(c.volume24h)} · MC {formatNum(c.mcAtScan)} · {age}m ago
                  </p>
                </div>
                <div className="text-right space-y-1">
                  <p className={`text-lg font-bold font-mono ${scoreColor(c.score)}`}>
                    {c.score}
                  </p>
                  <Badge variant="brand">
                    {STRATEGY_LABELS[c.strategyMatched] ?? c.strategyMatched}
                  </Badge>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
