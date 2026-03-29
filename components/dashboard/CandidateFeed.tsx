import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const MOCK_CANDIDATES = [
  { symbol: 'PEPE2', score: 87, strategy: 'evil-panda', volume: '1.2M', mc: '450K', age: '4h' },
  { symbol: 'MDOG', score: 72, strategy: 'evil-panda', volume: '680K', mc: '280K', age: '1h' },
  { symbol: 'KEKE', score: 61, strategy: 'evil-panda', volume: '310K', mc: '190K', age: '22m' },
]

export function CandidateFeed() {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">Candidate Feed</h2>
        <Badge variant="neutral">Mock data</Badge>
      </div>
      <div className="space-y-3">
        {MOCK_CANDIDATES.map((c) => (
          <div
            key={c.symbol}
            className="flex items-center justify-between p-3 rounded-lg bg-surface border border-surface-border hover:border-brand/30 transition-colors"
          >
            <div>
              <p className="text-sm font-mono font-semibold text-white">{c.symbol}</p>
              <p className="text-xs text-slate-500 mt-0.5">Vol {c.volume} · MC {c.mc} · {c.age}</p>
            </div>
            <div className="text-right space-y-1">
              <p className="text-lg font-bold font-mono text-brand-light">{c.score}</p>
              <Badge variant="brand">{c.strategy}</Badge>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
