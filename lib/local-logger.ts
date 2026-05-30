/**
 * lib/local-logger.ts
 *
 * Simple file-based logger to replace Supabase bot_logs.
 * Keeps logs locally + still sends important alerts via Telegram (through alerter).
 */

import * as fs from 'fs'
import * as path from 'path'

const LOG_DIR = path.join(process.cwd(), 'state')
const LOG_FILE = path.join(LOG_DIR, 'bot.log')

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

export type LogLevel = 'info' | 'warn' | 'error'

export function logToFile(level: LogLevel, event: string, payload?: Record<string, any>) {
  ensureLogDir()

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(payload ? { payload } : {}),
  }

  const line = JSON.stringify(entry) + '\n'

  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch (err) {
    console.error('[local-logger] Failed to write log:', err)
  }

  // Also print to console for convenience
  const prefix = `[${level.toUpperCase()}]`
  if (level === 'error') {
    console.error(prefix, event, payload || '')
  } else if (level === 'warn') {
    console.warn(prefix, event, payload || '')
  } else {
    console.log(prefix, event, payload || '')
  }
}

export function getRecentLogs(limit = 50): any[] {
  ensureLogDir()
  if (!fs.existsSync(LOG_FILE)) return []

  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}
