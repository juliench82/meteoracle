/**
 * worker.ts — Coolify/server entrypoint
 *
 * Runs as a persistent process (not a cron).
 * Monitor ticks every 60 seconds, scanner every 15 minutes.
 * Set BOT_ENABLED=true and BOT_DRY_RUN=true to start safely.
 */
import 'dotenv/config'
import { monitorPositions } from './bot/monitor'
import { runScanner } from './bot/scanner'

const MONITOR_INTERVAL_MS = parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') * 1_000
const SCANNER_INTERVAL_MS = 15 * 60 * 1_000  // 15 minutes

const BOT_ENABLED = process.env.BOT_ENABLED === 'true'
const DRY_RUN     = process.env.BOT_DRY_RUN === 'true'

function log(msg: string) {
  console.log(`[worker][${new Date().toISOString()}] ${msg}`)
}

async function tickMonitor() {
  if (!BOT_ENABLED) { log('monitor skipped — BOT_ENABLED=false'); return }
  try {
    log('monitor tick start')
    const stats = await monitorPositions()
    log(`monitor tick done — checked=${stats.checked} closed=${stats.closed} rebalanced=${stats.rebalanced}`)
  } catch (err) {
    console.error('[worker] monitor tick error:', err)
  }
}

async function tickScanner() {
  if (!BOT_ENABLED) { log('scanner skipped — BOT_ENABLED=false'); return }
  try {
    log('scanner tick start')
    const stats = await runScanner()
    log(`scanner tick done — scanned=${stats.scanned} candidates=${stats.candidates} opened=${stats.opened}`)
  } catch (err) {
    console.error('[worker] scanner tick error:', err)
  }
}

async function main() {
  log(`────────────────────────────────────────`)
  log(`Meteoracle worker starting`)
  log(`BOT_ENABLED : ${BOT_ENABLED}`)
  log(`BOT_DRY_RUN : ${DRY_RUN}`)
  log(`Monitor     : every ${MONITOR_INTERVAL_MS / 60_000} min`)
  log(`Scanner     : every ${SCANNER_INTERVAL_MS / 60_000} min`)
  log(`────────────────────────────────────────`)

  // Run both immediately on startup
  await tickMonitor()
  await tickScanner()

  // Then on independent intervals
  setInterval(tickMonitor, MONITOR_INTERVAL_MS)
  setInterval(tickScanner, SCANNER_INTERVAL_MS)
}

main().catch((err) => {
  console.error('[worker] fatal error:', err)
  process.exit(1)
})
