/**
 * lib/log.ts
 *
 * Clean logging facade.
 * Currently writes to local file (state/bot.log) + console.
 * Can later be extended to also forward important events.
 */

import { logToFile, LogLevel } from './local-logger'

export function logInfo(event: string, payload?: Record<string, any>) {
  logToFile('info', event, payload)
}

export function logWarn(event: string, payload?: Record<string, any>) {
  logToFile('warn', event, payload)
}

export function logError(event: string, payload?: Record<string, any>) {
  logToFile('error', event, payload)
}
