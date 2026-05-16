interface SpotKPIBarProps {
  solDeployed:   number
  openPositions: number
  totalTrades:   number
  walletSol?:     number | null
  portfolio?: {
    source?: string
    openCount?: number
    dlmmCount?: number
    dammCount?: number
    outOfRangeCount?: number
    totalPositionValueUsd?: number
    totalClaimableFeesUsd?: number
    totalFeesClaimedUsd?: number
    totalFeesEarnedUsd?: number
    averagePositionValueUsd?: number | null
    averageFeeApr24h?: number | null
    cachedHistory?: {
      closedCount?: number
      realizedPnlUsd?: number
      winRatePct?: number | null
      biggestWinUsd?: number | null
    }
  }
}

export function SpotKPIBar({
  solDeployed,
  openPositions,
  totalTrades,
  walletSol,
  portfolio,
}: SpotKPIBarProps) {
  const fmtUsd = (value: unknown) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return 'N/A'
    return `$${n.toFixed(2)}`
  }
  const fmtPct = (value: unknown) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return 'N/A'
    return `${n.toFixed(1)}%`
  }
  const history = portfolio?.cachedHistory
  const cards = [
    {
      label: 'Wallet SOL',
      value: walletSol != null ? `${walletSol.toFixed(3)} SOL` : 'N/A',
      sub:   'live RPC balance',
      color: 'text-emerald-300',
    },
    {
      label: 'Live LP Value',
      value: fmtUsd(portfolio?.totalPositionValueUsd),
      sub:   portfolio?.source === 'meteora-live'
        ? 'Meteora live positions'
        : portfolio?.source === 'meteora-live-partial'
          ? 'partial Meteora live'
          : 'cache fallback',
      color: 'text-white',
    },
    {
      label: 'Claimable Fees',
      value: fmtUsd(portfolio?.totalClaimableFeesUsd),
      sub:   'Meteora live',
      color: 'text-emerald-300',
    },
    {
      label: 'Fees Claimed',
      value: fmtUsd(portfolio?.totalFeesClaimedUsd),
      sub:   'live open positions',
      color: 'text-zinc-300',
    },
    {
      label: 'Average LP',
      value: portfolio?.averagePositionValueUsd != null ? fmtUsd(portfolio.averagePositionValueUsd) : 'N/A',
      sub:   `${portfolio?.openCount ?? openPositions} open LP position${(portfolio?.openCount ?? openPositions) !== 1 ? 's' : ''}`,
      color: 'text-zinc-200',
    },
    {
      label: 'Open Mix',
      value: `${portfolio?.dlmmCount ?? 0} / ${portfolio?.dammCount ?? 0}`,
      sub:   `DLMM / DAMM, ${portfolio?.outOfRangeCount ?? 0} OOR`,
      color: 'text-zinc-200',
    },
    {
      label: 'Fee APR 24h',
      value: portfolio?.averageFeeApr24h != null ? fmtPct(portfolio.averageFeeApr24h) : 'N/A',
      sub:   'average, when exposed by Meteora',
      color: 'text-zinc-300',
    },
    {
      label: 'Cached Realized PnL',
      value: history?.realizedPnlUsd != null ? fmtUsd(history.realizedPnlUsd) : 'N/A',
      sub:   `${history?.closedCount ?? totalTrades} cached closed position${(history?.closedCount ?? totalTrades) !== 1 ? 's' : ''}`,
      color: 'text-zinc-300',
    },
    {
      label: 'Cached Win Rate',
      value: history?.winRatePct != null ? fmtPct(history.winRatePct) : 'N/A',
      sub:   history?.biggestWinUsd != null ? `biggest win ${fmtUsd(history.biggestWinUsd)}` : 'closed cache only',
      color: 'text-zinc-300',
    },
    {
      label: 'SOL Deployed',
      value: `${solDeployed.toFixed(3)} SOL`,
      sub:   'bot cache / estimate',
      color: 'text-zinc-400',
    },
  ]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
      {cards.map(card => (
        <div key={card.label} className="retro-card min-h-[104px]">
          <div className="label">{card.label}</div>
          <div className={`value ${card.label.includes('PnL') || card.label.includes('Win') ? 'neon-lime' : 'neon-cyan'}`}>
            {card.value}
          </div>
          <p className="text-[10px] text-retro-text-dim mt-1 font-mono">{card.sub}</p>
        </div>
      ))}
    </div>
  )
}
