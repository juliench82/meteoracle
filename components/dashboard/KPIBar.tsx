import { Card } from '@/components/ui/Card'

interface KPIBarProps {
  solDeployed: number
  activePositions: number
  feesEarned24h: number
  winRate: number | null
  candidatesScanned: number
}

export function KPIBar({
  solDeployed,
  activePositions,
  feesEarned24h,
  winRate,
  candidatesScanned,
}: KPIBarProps) {
  const kpis = [
    {
      label: 'SOL Deployed',
      value: solDeployed.toFixed(3),
      unit: 'SOL',
      color: 'text-brand-light',
    },
    {
      label: 'Active Positions',
      value: String(activePositions),
      unit: '',
      color: 'text-white',
    },
    {
      label: 'Fees Earned',
      value: feesEarned24h.toFixed(4),
      unit: 'SOL',
      color: 'text-green-400',
      title: 'Cumulative fees earned on all active positions',
    },
    {
      label: 'Win Rate',
      value: winRate !== null ? `${winRate}%` : '—',
      unit: '',
      color: winRate !== null && winRate >= 50 ? 'text-green-400' : 'text-slate-300',
    },
    {
      label: 'Candidates',
      value: String(candidatesScanned),
      unit: '',
      color: 'text-slate-300',
    },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {kpis.map((kpi) => (
        <Card key={kpi.label} title={kpi.title}>
          <p className="text-xs text-slate-500 mb-1">{kpi.label}</p>
          <p className={`text-2xl font-bold font-mono tabular-nums ${kpi.color}`}>
            {kpi.value}
            {kpi.unit && (
              <span className="text-sm ml-1 text-slate-500">{kpi.unit}</span>
            )}
          </p>
        </Card>
      ))}
    </div>
  )
}
