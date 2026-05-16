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
          <div className="label">{kpi.label}</div>
          <div className={`value ${kpi.color.includes('brand') ? 'neon-purple' : 'neon-cyan'}`}>
            {kpi.value}
            {kpi.unit && (
              <span className="text-sm ml-1.5 text-retro-text-dim">{kpi.unit}</span>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}
