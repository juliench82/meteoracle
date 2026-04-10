interface WatchlistRow {
  id:           string
  mint:         string
  symbol:       string
  name:         string
  volume_1h_usd: number
  status:       string
  detected_at:  string
}

interface Props {
  watchlist: WatchlistRow[]
}

export function WatchlistFeed({ watchlist }: Props) {
  function statusDot(status: string) {
    if (status === 'watching') return 'bg-blue-400 animate-pulse'
    if (status === 'opened')   return 'bg-green-400'
    if (status === 'expired')  return 'bg-zinc-600'
    return 'bg-yellow-400'
  }

  function timeAgo(ts: string) {
    const mins = (Date.now() - new Date(ts).getTime()) / 60_000
    if (mins < 1)    return 'just now'
    if (mins < 60)   return `${Math.round(mins)}m ago`
    return `${Math.round(mins / 60)}h ago`
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
      <div className="px-5 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-semibold text-white">Watchlist</h3>
        <p className="text-xs text-zinc-500">Pre-grad tokens being tracked</p>
      </div>

      {watchlist.length === 0 ? (
        <p className="text-zinc-500 text-sm text-center py-10">No tokens on watchlist</p>
      ) : (
        <ul className="divide-y divide-zinc-800">
          {watchlist.map(row => (
            <li key={row.id} className="px-4 py-3 hover:bg-zinc-800/30">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${statusDot(row.status)}`} />
                  <div>
                    <a
                      href={`https://pump.fun/${row.mint}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-white hover:text-blue-400"
                    >
                      {row.symbol}
                    </a>
                    <p className="text-xs text-zinc-500">{row.mint.slice(0, 8)}...</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-zinc-300">{row.volume_1h_usd.toFixed(1)} SOL</p>
                  <p className="text-xs text-zinc-500">{timeAgo(row.detected_at)}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
