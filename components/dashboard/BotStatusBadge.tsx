export function BotStatusBadge() {
  // TODO: pull from /api/bot/status once wired
  const enabled = process.env.NEXT_PUBLIC_BOT_ENABLED === 'true'

  return (
    <div className="flex items-center gap-2">
      <span
        className={`w-2 h-2 rounded-full ${
          enabled ? 'bg-green-400 animate-pulse' : 'bg-slate-600'
        }`}
      />
      <span className="text-xs text-slate-400 font-mono">
        {enabled ? 'BOT LIVE' : 'BOT OFF'}
      </span>
    </div>
  )
}
