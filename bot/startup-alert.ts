/**
 * startup-alert.ts
 *
 * Call sendStartupAlert(processName) in every bot's main().
 * Only fires a Telegram ping when PM2 is restarting the process after a CRASH
 * (PM2_RESTART_COUNT > 0), so clean /restart commands stay silent.
 */

import { sendTelegram } from './telegram'

export async function sendStartupAlert(processName: string): Promise<void> {
  const restartCount = parseInt(process.env.PM2_RESTART_COUNT ?? '0', 10)

  // Only alert on crash recovery — skip clean starts and manual restarts
  if (restartCount === 0) return

  const dryRun = process.env.BOT_DRY_RUN !== 'false'
  const mode   = dryRun ? '🟡 DRY-RUN' : '🟢 LIVE'
  const ts     = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const msg    =
    `🚨 *Process crash-restarted*\n` +
    `Process: \`${processName}\`\n` +
    `Restarts: ${restartCount}\n` +
    `Mode: ${mode}\n` +
    `PID: ${process.pid}\n` +
    `Time: ${ts}`
  try {
    await sendTelegram(msg)
  } catch {
    // never block startup
  }
}
