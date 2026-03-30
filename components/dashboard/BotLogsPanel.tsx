import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

type LogLevel = 'info' | 'warn' | 'error'

interface BotLog {
  id: string
  level: LogLevel
  event: string
  payload?: Record<string, unknown>
  created_at: string
}

const levelVariant: Record<LogLevel, 'success' | 'warning' | 'danger' | 'neutral'> = {
  info: 'neutral',
  warn: 'warning',
  error: 'danger',
}

const levelIcon: Record<LogLevel, string> = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
}

export function BotLogsPanel({ logs }: { logs: BotLog[] }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-slate-200">Bot Logs</h2>
        <Badge variant="neutral">last 30</Badge>
      </div>

      {logs.length === 0 ? (
        <p className="text-slate-600 text-sm py-6 text-center">No logs yet</p>
      ) : (
        <div className="space-y-1 max-h-64 overflow-y-auto font-mono text-xs">
          {logs.map((log) => {
            const time = new Date(log.created_at).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })
            return (
              <div
                key={log.id}
                className="flex items-start gap-2 py-1 border-b border-surface-border/40 last:border-0"
              >
                <span className="text-slate-600 shrink-0 w-16">{time}</span>
                <span className="shrink-0">{levelIcon[log.level]}</span>
                <span className="text-slate-400 shrink-0">
                  <Badge variant={levelVariant[log.level]}>{log.event}</Badge>
                </span>
                {log.payload && (
                  <span className="text-slate-600 truncate">
                    {JSON.stringify(log.payload)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
