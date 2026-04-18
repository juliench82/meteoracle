interface SpotKPIBarProps {
  solDeployed:    number
  openPositions:  number
  totalPnlSol:    number
  winRate:        number | null
  totalTrades:    number
}

export function SpotKPIBar({
  solDeployed,
  openPositions,
  totalPnlSol,
  winRate,
  totalTrades,
}: SpotKPIBarProps) {
  const pnlColor = totalPnlSol >= 0 ? 'text-green-400' : 'text-red-400'
  const pnlSign  = totalPnlSol >= 0 ? '+' : ''

  const cards = [
    {
      label: 'SOL Deployed',
      value: `${solDeployed.toFixed(3)} SOL`,
      sub:   `${openPositions} open position${openPositions !== 1 ? 's' : ''}`,
      color: 'text-white',
    },
    {
      label: 'Total P&L',
      value: `${pnlSign}${totalPnlSol.toFixed(4)} SOL`,
      sub:   `${totalTrades} closed trades`,
      color: pnlColor,
    },
    {
      label: 'Win Rate',
      value: winRate !== null ? `${winRate}%` : '—',
      sub:   `${totalTrades} trades`,
      color: winRate !== null && winRate >= 50 ? 'text-green-400' : 'text-yellow-400',
    },
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {cards.map(card => (
        <div key={card.label} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{card.label}</p>
          <p className={`text-2xl font-bold ${card.color}`}>{card.value}</p>
          <p className="text-xs text-zinc-500 mt-1">{card.sub}</p>
        </div>
      ))}
    </div>
  )
}
