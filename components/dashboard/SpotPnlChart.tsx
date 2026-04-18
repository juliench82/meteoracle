'use client'

export function SpotPnlChart() {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold text-white mb-1">Real P&amp;L</h3>
        <p className="text-xs text-zinc-400">
          Accurate P&amp;L with fee breakdown, IL, and timeframe filters (1D / 1W / 1M) is available directly on Meteora.
        </p>
      </div>
      <a
        href="https://app.meteora.ag/"
        target="_blank"
        rel="noreferrer"
        className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
      >
        View on Meteora
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14 3h7m0 0v7m0-7L10 14M5 5H3a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-2" />
        </svg>
      </a>
    </div>
  )
}
