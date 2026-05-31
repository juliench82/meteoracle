/**
 * worker.ts — Coolify/server entrypoint
 *
 * Runs as a persistent process (not a cron).
 * Monitor ticks every 60 seconds, scanner every 15 minutes.
 * Set BOT_ENABLED=true and BOT_DRY_RUN=true to start safely.
 */
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { monitorPositions } from './bot/monitor'
import { runScanner } from './bot/scanner'

const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1_000
const SCANNER_INTERVAL_MS = parseInt(process.env.LP_SCAN_INTERVAL_SEC ?? '900') * 1_000

const BOT_ENABLED = process.env.BOT_ENABLED === 'true'
const DRY_RUN     = process.env.BOT_DRY_RUN === 'true'
const LP_MONITOR_ENABLED = process.env.LP_MONITOR_ENABLED !== 'false'
const LP_SCANNER_ENABLED = process.env.LP_SCANNER_ENABLED !== 'false' &&
  process.env.SCANNER_ENABLED !== 'false'

function log(msg: string) {
  console.log(`[worker][${new Date().toISOString()}] ${msg}`)
}

async function tickMonitor() {
  if (!BOT_ENABLED) { log('monitor skipped — BOT_ENABLED=false'); return }
  if (!LP_MONITOR_ENABLED) { log('monitor skipped — LP_MONITOR_ENABLED=false'); return }
  inFlightMonitor = true
  try {
    log('monitor tick start')
    const stats = await monitorPositions()
    log(`monitor tick done — checked=${stats.checked} closed=${stats.closed}`)
  } catch (err) {
    console.error('[worker] monitor tick error:', err)
  } finally {
    inFlightMonitor = false
  }
}

async function tickScanner() {
  if (!BOT_ENABLED) { log('scanner skipped — BOT_ENABLED=false'); return }
  if (!LP_SCANNER_ENABLED) { log('scanner skipped — LP_SCANNER_ENABLED=false'); return }
  inFlightScanner = true
  try {
    log('scanner tick start')
    const stats = await runScanner()
    const blocked = stats.openBlockedReason ? ` openBlocked=${stats.openBlockedReason}` : ''
    log(
      `scanner tick done — scanned=${stats.scanned} survivors=${stats.survivors} ` +
      `deepChecked=${stats.deepChecked} candidates=${stats.candidates} opened=${stats.opened} ` +
      `openSkipped=${stats.openSkipped}${blocked}`,
    )
  } catch (err) {
    console.error('[worker] scanner tick error:', err)
  } finally {
    inFlightScanner = false
  }
}

async function main() {
  log(`────────────────────────────────────────`)
  log(`Meteoracle worker starting`)
  log(`BOT_ENABLED : ${BOT_ENABLED}`)
  log(`BOT_DRY_RUN : ${DRY_RUN}`)
  log(`LP_MONITOR  : ${LP_MONITOR_ENABLED}`)
  log(`LP_SCANNER  : ${LP_SCANNER_ENABLED}`)
  log(`Monitor     : every ${MONITOR_INTERVAL_MS / 60_000} min`)
  log(`Scanner     : every ${SCANNER_INTERVAL_MS / 60_000} min`)
  log(`────────────────────────────────────────`)

  // Run both immediately on startup
  inFlightMonitor = true
  inFlightScanner = true
  try {
    await tickMonitor()
    await tickScanner()
  } finally {
    inFlightMonitor = false
    inFlightScanner = false
  }

  // Then on independent intervals
  setInterval(tickMonitor, MONITOR_INTERVAL_MS)
  setInterval(tickScanner, SCANNER_INTERVAL_MS)
}

let isShuttingDown = false

// Simple in-flight tracking for diagnostics
let inFlightMonitor = false
let inFlightScanner = false

function gracefulShutdown(signal: string) {
  if (isShuttingDown) return
  isShuttingDown = true

  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  const uptime = process.uptime()

  console.error('=== GRACEFUL SHUTDOWN TRIGGERED ===')
  console.error(`Signal: ${signal}`)
  console.error(`Time: ${new Date().toISOString()}`)
  console.error(`Uptime: ${uptime.toFixed(1)}s`)
  console.error(`In-flight: monitor=${inFlightMonitor}, scanner=${inFlightScanner}`)
  console.error('Memory usage (bytes):', {
    rss: mem.rss,
    heapTotal: mem.heapTotal,
    heapUsed: mem.heapUsed,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  })
  console.error('CPU usage (microseconds):', cpu)
  console.error('Active handles count:', (process as any)._getActiveHandles?.()?.length ?? 'n/a')
  console.error('Active requests count:', (process as any)._getActiveRequests?.()?.length ?? 'n/a')
  console.error('=====================================')

  log(`received ${signal} — starting graceful shutdown`)

  // Stop scheduling new ticks
  // Note: current in-flight ticks will finish naturally

  // Give in-flight work a chance to complete
  setTimeout(() => {
    log('graceful shutdown complete')
    process.exit(0)
  }, 5000).unref()
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

main().catch((err) => {
  console.error('[worker] fatal error:', err)
  process.exit(1)
})
