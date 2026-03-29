import { Card } from '@/components/ui/Card'

const kpis = [
  { label: 'SOL Deployed', value: '0.00', unit: 'SOL', color: 'text-brand-light' },
  { label: 'Active Positions', value: '0', unit: '', color: 'text-white' },
  { label: 'Fees Earned (24h)', value: '0.000', unit: 'SOL', color: 'text-green-400' },
  { label: 'Win Rate', value: '—', unit: '', color: 'text-slate-300' },
  { label: 'Candidates Scanned', value: '0', unit: '', color: 'text-slate-300' },
]

export function KPIBar() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {kpis.map((kpi) => (
        <Card key={kpi.label}>
          <p className="text-xs text-slate-500 mb-1">{kpi.label}</p>
          <p className={`text-2xl font-bold font-mono ${kpi.color}`}>
            {kpi.value}
            {kpi.unit && <span className="text-sm ml-1 text-slate-500">{kpi.unit}</span>}
          </p>
        </Card>
      ))}
    </div>
  )
}
