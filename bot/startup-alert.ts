/**
 * startup-alert.ts
 *
 * Call sendStartupAlert(processName) at the top of every bot's main().
 * Fires a Telegram ping so you know when PM2 restarts a process after a crash.
 */

import { sendTelegram } from './telegram'

export async function sendStartupAlert(processName: string): Promise<void> {
  const dryRun = process.env.BOT_DRY_RUN !== 'false'
  const mode   = dryRun ? '🟡 DRY-RUN' : '🟢 LIVE'
  const ts     = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const msg    =
    `🔄 *Bot (re)started*\n` +
    `Process: \`${processName}\`\n` +
    `Mode: ${mode}\n` +
    `PID: ${process.pid}\n` +
    `Time: ${ts}`
  try {
    await sendTelegram(msg)
  } catch {
    // never block startup
  }
}
