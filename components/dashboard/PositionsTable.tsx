import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

const MOCK_POSITIONS = [
  {
    id: '1',
    symbol: 'BONK',
    strategy: 'evil-panda',
    entryPrice: 0.0000220,
    currentPrice: 0.0000210,
    inRange: true,
    pnlSol: +0.012,
    solDeposited: 0.5,
    openedAt: '2h ago',
  },
]

export function PositionsTable() {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">Open Positions</h2>
        <Badge variant="neutral">Mock data</Badge>
      </div>

      {MOCK_POSITIONS.length === 0 ? (
        <p className="text-slate-600 text-sm py-8 text-center">No open positions</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-surface-border">
                {['Token', 'Strategy', 'Entry', 'Current', 'Range', 'Fees', 'Deployed', 'Age'].map(h => (
                  <th key={h} className="text-left py-2 pr-4 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MOCK_POSITIONS.map((p) => (
                <tr key={p.id} className="border-b border-surface-border/50 hover:bg-surface-border/30 transition-colors">
                  <td className="py-3 pr-4 font-mono font-semibold text-white">{p.symbol}</td>
                  <td className="py-3 pr-4">
                    <Badge variant="brand">{p.strategy}</Badge>
                  </td>
                  <td className="py-3 pr-4 font-mono text-slate-400">{p.entryPrice.toFixed(7)}</td>
                  <td className="py-3 pr-4 font-mono text-slate-300">{p.currentPrice.toFixed(7)}</td>
                  <td className="py-3 pr-4">
                    <Badge variant={p.inRange ? 'success' : 'danger'}>
                      {p.inRange ? '✓ In range' : '✗ Out of range'}
                    </Badge>
                  </td>
                  <td className={`py-3 pr-4 font-mono ${p.pnlSol >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {p.pnlSol >= 0 ? '+' : ''}{p.pnlSol.toFixed(4)} SOL
                  </td>
                  <td className="py-3 pr-4 font-mono text-slate-400">{p.solDeposited} SOL</td>
                  <td className="py-3 text-slate-500">{p.openedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
