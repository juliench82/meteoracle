interface SpotKPIBarProps {
  solDeployed:   number
  openPositions: number
  totalTrades:   number
  walletSol?:     number | null
}

export function SpotKPIBar({
  solDeployed,
  openPositions,
  totalTrades,
  walletSol,
}: SpotKPIBarProps) {
  const cards = [
    {
      label: 'Wallet SOL',
      value: walletSol != null ? `${walletSol.toFixed(3)} SOL` : 'N/A',
      sub:   'live RPC balance',
      color: 'text-emerald-300',
    },
    {
      label: 'SOL Deployed',
      value: `${solDeployed.toFixed(3)} SOL`,
      sub:   `${openPositions} open position${openPositions !== 1 ? 's' : ''}`,
      color: 'text-white',
    },
    {
      label: 'Total Trades',
      value: String(totalTrades),
      sub:   'closed positions',
      color: 'text-zinc-300',
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
