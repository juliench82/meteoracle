/**
 * lib/logger.ts
 *
 * Lightweight structured logger (no external dependencies).
 * Safe for Supabase free tier + Hetzner.
 *
 * Usage:
 *   import { log } from '@/lib/logger'
 *   log.info('scanner tick', { scanned: 142, survivors: 7 })
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const currentLevel = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel
const minLevel = LEVELS[currentLevel] ?? LEVELS.info

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= minLevel
}

function format(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString()
  const base = `[${ts}] [${level.toUpperCase()}] ${msg}`
  if (meta && Object.keys(meta).length > 0) {
    return `${base} ${JSON.stringify(meta)}`
  }
  return base
}

export const log = {
  debug(msg: string, meta?: Record<string, unknown>) {
    if (shouldLog('debug')) console.debug(format('debug', msg, meta))
  },
  info(msg: string, meta?: Record<string, unknown>) {
    if (shouldLog('info')) console.log(format('info', msg, meta))
  },
  warn(msg: string, meta?: Record<string, unknown>) {
    if (shouldLog('warn')) console.warn(format('warn', msg, meta))
  },
  error(msg: string, meta?: Record<string, unknown>) {
    if (shouldLog('error')) console.error(format('error', msg, meta))
  },
}

export default log