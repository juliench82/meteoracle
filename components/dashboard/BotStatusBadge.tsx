'use client'

import { useEffect, useState } from 'react'

export function BotStatusBadge() {
  const [status, setStatus] = useState<'live' | 'dry-run' | 'off'>('off')

  useEffect(() => {
    // Read from meta tags injected server-side via layout
    const enabled = document.querySelector('meta[name="bot-enabled"]')?.getAttribute('content')
    const dryRun = document.querySelector('meta[name="bot-dry-run"]')?.getAttribute('content')
    if (enabled === 'true') {
      setStatus(dryRun === 'true' ? 'dry-run' : 'live')
    } else {
      setStatus('off')
    }
  }, [])

  const config = {
    live: { dot: 'bg-green-400 animate-pulse', label: 'BOT LIVE', color: 'text-green-400' },
    'dry-run': { dot: 'bg-yellow-400 animate-pulse', label: 'DRY RUN', color: 'text-yellow-400' },
    off: { dot: 'bg-slate-600', label: 'BOT OFF', color: 'text-slate-400' },
  }[status]

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${config.dot}`} />
      <span className={`text-xs font-mono ${config.color}`}>{config.label}</span>
    </div>
  )
}
