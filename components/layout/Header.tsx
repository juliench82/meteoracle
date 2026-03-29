import { BotStatusBadge } from '@/components/dashboard/BotStatusBadge'

export function Header() {
  return (
    <header className="h-14 flex items-center justify-between px-6 border-b border-surface-border bg-surface-elevated flex-shrink-0">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-slate-300">Overview</h1>
      </div>
      <div className="flex items-center gap-4">
        <BotStatusBadge />
        <span className="text-xs text-slate-500">{new Date().toUTCString().replace(' GMT', ' UTC')}</span>
      </div>
    </header>
  )
}
