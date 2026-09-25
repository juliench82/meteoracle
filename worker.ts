/**
 * worker.ts — Coolify/server entrypoint
 *
 * Runs as a persistent process (not a cron).
 * Monitor ticks every 60 seconds, scanner every 15 minutes.
 *
 * GATING (audit §M2 — single source of truth):
 *   - `BOT_ENABLED` / `BOT_DRY_RUN` are STARTUP SEEDS ONLY, folded into the
 *     persisted `botState` once at boot by lib/botState.ts.  They are NOT read
 *     here and NOT read per tick: a stale `BOT_ENABLED=false` cannot disable a
 *     bot the operator started with `/start`, and `BOT_ENABLED=true` cannot
 *     resurrect one the operator stopped with `/stop`.
 *   - Enable / pause are resolved on EVERY tick from `getBotState()` via the
 *     pure `resolveEffectiveGates` (lib/gates.ts).
 *   - `LP_MONITOR_ENABLED` / `LP_SCANNER_ENABLED` (and legacy `SCANNER_ENABLED`)
 *     remain operator HARD-KILLS, resolved per stream so a monitor kill cannot
 *     suppress the scanner.
 */
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { monitorPositions } from './bot/monitor'
import { runScanner } from './bot/scanner'
import { getBotState } from './lib/botState'
import { resolveEffectiveGates } from './lib/gates'
import { validateStartup } from './lib/startup-validation'
import { enforceConfigInvariantOpenGate } from './lib/config-invariant-gate'
import { retryStrandedSells } from './lib/swap'
import { getConnection } from './lib/solana'
import { summarizeError } from './lib/logging'
import { flushStateWrites } from './lib/local-state'

const MONITOR_INTERVAL_MS = (parseInt(process.env.LP_MONITOR_INTERVAL_SEC ?? '60') || 60) * 1_000
const SCANNER_INTERVAL_MS = (parseInt(process.env.LP_SCAN_INTERVAL_SEC ?? '900') || 900) * 1_000

// Operator HARD-KILLS, parsed once at boot. A `false` value blocks work for
// that stream regardless of botState (see lib/gates.ts `GateFlags`).
const LP_MONITOR_ENABLED = process.env.LP_MONITOR_ENABLED !== 'false'
const LP_SCANNER_ENABLED = process.env.LP_SCANNER_ENABLED !== 'false' &&
  process.env.SCANNER_ENABLED !== 'false'

function log(msg: string) {
  console.log(`[worker][${new Date().toISOString()}] ${msg}`)
}

/**
 * Read the persisted bot state for this tick.
 *
 * Fail CLOSED: if the state file cannot be read we return `null` and the caller
 * skips the tick.  Trading work must never be enabled by an unreadable state
 * file (the persisted default in lib/botState.ts is `enabled: false` too).
 */
async function readBotState(label: string) {
  try {
    return await getBotState()
  } catch (err) {
    log(`${label} skipped — botState unreadable (${summarizeError(err)})`)
    return null
  }
}

export async function tickMonitor() {
  const bs = await readBotState('monitor')
  if (!bs) return

  // botState is the single source of truth; LP_MONITOR_ENABLED is a hard-kill.
  const gates = resolveEffectiveGates(bs, process.env, { monitorEnabled: LP_MONITOR_ENABLED })
  if (!gates.enabled) {
    const why = !LP_MONITOR_ENABLED
      ? 'LP_MONITOR_ENABLED=false'
      : `botState enabled=${bs.enabled} paused=${gates.paused}`
    log(`monitor skipped — gate closed (${why})`)
    return
  }

  if (inFlightMonitor) {
    log('monitor tick skipped — previous tick still in flight (overlap protection)')
    return
  }
  inFlightMonitor = true
  try {
    log('monitor tick start')
    const stats = await monitorPositions()
    log(`monitor tick done — checked=${stats.checked} closed=${stats.closed}`)
  } catch (err) {
    console.error('[worker] monitor tick error:', summarizeError(err))
    const msg = String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('429') || msg.includes('socket hang up')) {
      getConnection(true)
      log('[worker] RPC reset triggered')
    }
  } finally {
    inFlightMonitor = false
  }
}

export async function tickScanner() {
  const bs = await readBotState('scanner')
  if (!bs) return

  // botState is the single source of truth; LP_SCANNER_ENABLED is a hard-kill.
  const gates = resolveEffectiveGates(bs, process.env, { scannerEnabled: LP_SCANNER_ENABLED })
  if (!gates.enabled) {
    const why = !LP_SCANNER_ENABLED
      ? 'LP_SCANNER_ENABLED=false'
      : `botState enabled=${bs.enabled} paused=${gates.paused}`
    log(`scanner skipped — gate closed (${why})`)
    return
  }

  if (inFlightScanner) {
    log('scanner tick skipped — previous tick still in flight')
    return
  }
  inFlightScanner = true
  setOpenInProgress(true)
  try {
    log('scanner tick start')
    const stats = await runScanner()
    const blocked = stats.openBlockedReason ? ` openBlocked=${stats.openBlockedReason}` : ''
    const api = stats.apiPools != null ? ` apiPools=${stats.apiPools}` : ''
    log(
      `scanner tick done — scanned=${stats.scanned} candidates=${stats.candidates} ` +
      `processed=${stats.processed} opened=${stats.opened} ` +
      `openSkipped=${stats.openSkipped}${blocked}${api}`,
    )
  } catch (err) {
    console.error('[worker] scanner tick error:', summarizeError(err))
    const msg = String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('429') || msg.includes('socket hang up')) {
      getConnection(true)
      log('[worker] RPC reset triggered')
    }
  } finally {
    setOpenInProgress(false)
    inFlightScanner = false
  }
}

async function main() {
  log(`────────────────────────────────────────`)
  log(`Meteoracle worker starting`)
  log(`LP_MONITOR  : ${LP_MONITOR_ENABLED}`)
  log(`LP_SCANNER  : ${LP_SCANNER_ENABLED}`)
  log(`Monitor     : every ${MONITOR_INTERVAL_MS / 60_000} min`)
  log(`Scanner     : every ${SCANNER_INTERVAL_MS / 60_000} min`)
  try {
    // BOT_ENABLED / BOT_DRY_RUN are seeds only: report the EFFECTIVE gates.
    const bs = await getBotState()
    const gates = resolveEffectiveGates(bs, process.env, {
      monitorEnabled: LP_MONITOR_ENABLED,
      scannerEnabled: LP_SCANNER_ENABLED,
    })
    log(`botState    : enabled=${bs.enabled} dry_run=${bs.dry_run} paused=${bs.paused ?? false}`)
    log(`effective   : enabled=${gates.enabled} dryRun=${gates.dryRun} dryRunPinnedByEnv=${gates.dryRunPinnedByEnv}`)
  } catch {
    log(`botState    : (unreadable, will default disabled)`)
  }
  log(`────────────────────────────────────────`)

  // Startup validation — consumed, not fire-and-forget (H3).
  // The boolean result remains non-fatal for RPC/balance warnings, but the
  // fee/TVL config invariant is enforced fail-closed on the open path below.
  const passed = await validateStartup('worker').catch(() => false)
  if (passed === false) log('startup validation had warnings (see above)')

  // H3: consult the fee/TVL exit-vs-entry invariant. On breach with
  // ALLOW_CONFIG_INVARIANT_BREACH unset/'false' the scanner open gate refuses
  // NEW opens and exactly ONE Telegram alert is emitted (alerter latched).
  // Existing positions' exits are unaffected. With ALLOW_CONFIG_INVARIANT_BREACH=true
  // we warn and proceed.
  const { gate } = await enforceConfigInvariantOpenGate()
  if (!gate.ok && gate.allowBreach) {
    log('config invariant BREACHED — ALLOW_CONFIG_INVARIANT_BREACH=true, warn-and-proceed')
  } else if (!gate.openAllowed) {
    log(`config invariant BREACHED — NEW opens refused (${gate.reason}); existing exits unaffected`)
  } else {
    log(`config invariant ok — exit ${gate.exitPct}% < entry ${gate.entryPct}%`)
  }

  // Run both immediately on startup (serialized)
  inFlightMonitor = true
  inFlightScanner = true
  try {
    await tickMonitor()
    await tickScanner()
  } finally {
    inFlightMonitor = false
    inFlightScanner = false
  }

  // Recursive setTimeout schedule: next tick only starts AFTER previous completes.
  // Stronger than setInterval + guard against overlap under slow RPC / long ticks.
  function scheduleMonitor() {
    monitorIntervalHandle = setTimeout(async () => {
      await tickMonitor().catch(e => console.error('[worker] monitor schedule error', e))
      if (!isShuttingDown) scheduleMonitor()
    }, MONITOR_INTERVAL_MS) as any
  }
  function scheduleScanner() {
    scannerIntervalHandle = setTimeout(async () => {
      await tickScanner().catch(e => console.error('[worker] scanner schedule error', e))
      if (!isShuttingDown) scheduleScanner()
    }, SCANNER_INTERVAL_MS) as any
  }

  scheduleMonitor()
  scheduleScanner()

  // Independent schedule for stranded sell recovery so it doesn't block monitor tick (which does PnL/OOR/SL checks)
  // Runs every 90s independently
  function scheduleStrandedSells() {
    setTimeout(async () => {
      await retryStrandedSells().catch(e => console.error('[worker] stranded sells schedule error', e))
      if (!isShuttingDown) scheduleStrandedSells()
    }, 90_000).unref()
  }
  // fire first one after a short delay
  setTimeout(() => { if (!isShuttingDown) void retryStrandedSells().catch(() => {}) }, 15_000).unref()
  scheduleStrandedSells()
}

let isShuttingDown = false

// Simple in-flight tracking for diagnostics
let inFlightMonitor = false
let inFlightScanner = false

// Track if an open is in progress so graceful shutdown can wait
// (globalThis mirror removed per fix 4; only this exported var now)
export let openInProgress = false
export function setOpenInProgress(v: boolean) {
  openInProgress = !!v
}

// Stored to allow clean shutdown (clearInterval)
let monitorIntervalHandle: ReturnType<typeof setInterval> | null = null
let scannerIntervalHandle: ReturnType<typeof setInterval> | null = null

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
  if (monitorIntervalHandle) { clearTimeout(monitorIntervalHandle as any); monitorIntervalHandle = null }
  if (scannerIntervalHandle) { clearTimeout(scannerIntervalHandle as any); scannerIntervalHandle = null }

  // Give in-flight work a chance to complete (longer for opens)
  const waitForOpens = async () => {
    const deadline = Date.now() + 90_000  // full open can take 60-90s on congestion
    while (openInProgress && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
    }
  }
  waitForOpens().then(async () => {
    // Drain any pending state writes to avoid losing position updates on restart
    await flushStateWrites().catch(() => {})
    log('graceful shutdown complete')
    process.exit(0)
  }).catch(() => process.exit(0))
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

// Start the loop only when this module is NOT being imported by the test suite.
// Unit tests (tests/worker-gates.test.ts) import `tickMonitor`/`tickScanner` and
// must not boot the scheduler, hit the network, or create a `state/` dir.
// Every real runtime — `tsx worker.ts`, `node dist/worker.js`, pm2 — leaves both
// flags unset and starts exactly as before.
const underTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
if (!underTest) {
  main().catch((err) => {
    console.error('[worker] fatal error:', err)
    process.exit(1)
  })
}