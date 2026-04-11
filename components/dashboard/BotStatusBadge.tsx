'use client'

import { useEffect, useState } from 'react'

type Status = 'live' | 'dry-run' | 'off'

export function BotStatusBadge() {
  const [status, setStatus] = useState<Status>('off')

  useEffect(() => {
    let cancelled = false

    async function fetchStatus() {
      try {
        const res = await fetch('/api/bot/status', { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        if (data.enabled) {
          setStatus(data.dryRun ? 'dry-run' : 'live')
        } else {
          setStatus('off')
        }
      } catch {
        // silently keep previous state
      }
    }

    fetchStatus()
    const id = setInterval(fetchStatus, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const config: Record<Status, { dot: string; label: string; color: string }> = {
    live:      { dot: 'bg-green-400 animate-pulse',  label: 'BOT LIVE', color: 'text-green-400' },
    'dry-run': { dot: 'bg-yellow-400 animate-pulse', label: 'DRY RUN',  color: 'text-yellow-400' },
    off:       { dot: 'bg-slate-600',                label: 'BOT OFF',   color: 'text-slate-400' },
  }

  const { dot, label, color } = config[status]

  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      <span className={`text-xs font-mono ${color}`}>{label}</span>
    </div>
  )
}
