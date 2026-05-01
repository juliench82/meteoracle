import { Card } from '@/components/ui/Card'

interface KPIBarProps {
  solDeployed: number
  activePositions: number
  totalPositions: number
  candidatesScanned: number
}

export function KPIBar({
  solDeployed,
  activePositions,
  totalPositions,
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
      label: 'Total Trades',
      value: String(totalPositions),
      unit: '',
      color: 'text-slate-300',
    },
    {
      label: 'Candidates',
      value: String(candidatesScanned),
      unit: '',
      color: 'text-slate-300',
    },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      {kpis.map((kpi) => (
        <Card key={kpi.label}>
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
