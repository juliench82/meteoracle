import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export default async function BotPage() {
  const supabase = createServerClient()

  const [openRes, watchlistRes, recentRes] = await Promise.allSettled([
    supabase
      .from('spot_positions')
      .select('id, symbol, mint, amount_sol, status, opened_at, dry_run')
      .eq('status', 'open')
      .order('opened_at', { ascending: false }),
    supabase
      .from('pre_grad_watchlist')
      .select('id, symbol, mint, volume_1h_usd, status, detected_at')
      .eq('status', 'watching')
      .order('detected_at', { ascending: false })
      .limit(10),
    supabase
      .from('spot_positions')
      .select('id, symbol, status, pnl_sol, closed_at, dry_run')
      .in('status', ['closed_tp', 'closed_sl'])
      .order('closed_at', { ascending: false })
      .limit(10),
  ])

  const open      = openRes.status      === 'fulfilled' ? (openRes.value.data      ?? []) : []
  const watchlist = watchlistRes.status === 'fulfilled' ? (watchlistRes.value.data ?? []) : []
  const recent    = recentRes.status    === 'fulfilled' ? (recentRes.value.data    ?? []) : []

  const dryRun = open.length > 0 ? open[0].dry_run : true

  function timeAgo(ts: string) {
    const mins = (Date.now() - new Date(ts).getTime()) / 60_000
    if (mins < 1)    return 'just now'
    if (mins < 60)   return `${Math.round(mins)}m ago`
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`
    return `${Math.round(mins / 1440)}d ago`
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Bot Status</h1>
          <p className="text-sm text-zinc-500 mt-1">Live process health and activity</p>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${
          dryRun ? 'bg-yellow-900 text-yellow-300' : 'bg-green-900 text-green-300'
        }`}>
          {dryRun ? 'DRY RUN' : 'LIVE'}
        </span>
      </div>

      {/* Processes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { name: 'scanner',  desc: 'Scans pump.fun for pre-grad tokens', interval: '60s' },
          { name: 'buyer',    desc: 'Opens positions from watchlist',      interval: '30s' },
          { name: 'monitor',  desc: 'Watches TP / SL / timeout exits',    interval: '30s' },
        ].map(p => (
          <div key={p.name} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-sm font-semibold text-white font-mono">{p.name}</span>
            </div>
            <p className="text-xs text-zinc-500 mb-1">{p.desc}</p>
            <p className="text-xs text-zinc-600">Polls every {p.interval}</p>
          </div>
        ))}
      </div>

      {/* Open Positions */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
        <div className="px-5 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-white">Open Positions ({open.length})</h3>
        </div>
        {open.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-8">No open positions</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {open.map((p: any) => (
              <li key={p.id} className="px-5 py-3 flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-white">{p.symbol}</span>
                  <span className="ml-2 text-xs text-zinc-500">{p.mint.slice(0, 8)}...</span>
                </div>
                <div className="text-right">
                  <p className="text-sm text-zinc-300">{p.amount_sol} SOL</p>
                  <p className="text-xs text-zinc-500">{timeAgo(p.opened_at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Watching */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
        <div className="px-5 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-white">Watchlist — pending buy ({watchlist.length})</h3>
        </div>
        {watchlist.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-8">Watchlist empty</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {watchlist.map((r: any) => (
              <li key={r.id} className="px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                  <div>
                    <a
                      href={`https://pump.fun/${r.mint}`}
                      target="_blank" rel="noreferrer"
                      className="text-sm font-medium text-white hover:text-blue-400"
                    >
                      {r.symbol}
                    </a>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm text-zinc-300">{r.volume_1h_usd?.toFixed(1)} SOL vol</p>
                  <p className="text-xs text-zinc-500">{timeAgo(r.detected_at)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Recent closes */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl">
        <div className="px-5 py-3 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-white">Recent Exits</h3>
        </div>
        {recent.length === 0 ? (
          <p className="text-zinc-500 text-sm text-center py-8">No exits yet</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {recent.map((p: any) => {
              const isWin = (p.pnl_sol ?? 0) > 0
              return (
                <li key={p.id} className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span>{p.status === 'closed_tp' ? '🟢' : '🔴'}</span>
                    <span className="text-sm font-medium text-white">{p.symbol}</span>
                    {p.dry_run && <span className="text-xs text-yellow-500">(dry)</span>}
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${ isWin ? 'text-green-400' : 'text-red-400'}`}>
                      {isWin ? '+' : ''}{(p.pnl_sol ?? 0).toFixed(4)} SOL
                    </p>
                    <p className="text-xs text-zinc-500">{p.closed_at ? timeAgo(p.closed_at) : ''}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
