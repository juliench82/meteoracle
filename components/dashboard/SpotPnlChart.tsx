'use client'

export function SpotPnlChart() {
  return (
    <div className="retro-card flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div>
        <div className="label text-retro-pink">REALIZED P&amp;L + FEES</div>
        <p className="text-sm text-retro-text-dim mt-1">
          Accurate historical PnL, IL, and fee data is best viewed on Meteora.
        </p>
      </div>
      <a
        href="https://app.meteora.ag/"
        target="_blank"
        rel="noreferrer"
        className="retro-btn inline-flex items-center gap-2"
      >
        VIEW ON METEORA →
      </a>
    </div>
  )
}
