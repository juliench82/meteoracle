/**
 * telegram-bot.ts
 *
 * Standalone Telegram command bot using long-polling (getUpdates).
 * No webhook, no HTTPS, no Vercel needed — runs as a PM2 process on the VPS.
 *
 * Commands:
 *   /stop              — EMERGENCY: close all positions + pm2 stop all
 *   /restart           — resume: setBotState enabled + pm2 restart all
 *   /dry               — switch to dry-run mode
 *   /live              — switch to live trading
 *   /close <id>        — force-close an LP position by ID
 *   /closespot <id>    — force-close a spot position by ID
 *   /status            — snapshot: state, open positions, wallet SOL
 *   /positions         — list all open LP positions
 *   /spots             — list all open spot positions
 *   /tick              — manually trigger all pipelines in parallel
 *   /help              — command list
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createServerClient } from '@/lib/supabase'
import { getBotState, setBotState } from '@/lib/botState'
import { closePosition } from '@/bot/executor'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { runPreGradScanner } from '@/bot/pre-grad-scanner'
import { runSpotMonitor } from '@/bot/spot-monitor'
import { runLpMigrator } from '@/bot/lp-migrator'

const execAsync = promisify(exec)
const PM2 = '/usr/local/bin/pm2'

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN ?? ''
const CHAT_ID         = process.env.TELEGRAM_CHAT_ID   ?? ''
const POLL_MS         = 2_000
const TICK_TIMEOUT_MS = 55_000
const API             = `https://api.telegram.org/bot${BOT_TOKEN}`

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — exiting')
  process.exit(1)
}

let lastUpdateId = 0

// ─── Telegram helpers ────────────────────────────────────────────────────

async function reply(text: string): Promise<void> {
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id:                  CHAT_ID,
      text,
      parse_mode:               'Markdown',
      disable_web_page_preview: true,
    }, { timeout: 5_000 })
  } catch (err) {
    console.warn('[telegram-bot] reply failed:', err instanceof Error ? err.message : err)
  }
}

async function getUpdates(): Promise<TelegramUpdate[]> {
  try {
    const res = await axios.get(`${API}/getUpdates`, {
      params: { offset: lastUpdateId + 1, timeout: 10, limit: 100 },
      timeout: 15_000,
    })
    return res.data?.result ?? []
  } catch {
    return []
  }
}

interface TelegramUpdate {
  update_id: number
  message?: { chat: { id: number }; text?: string }
}

// ─── PM2 helpers ─────────────────────────────────────────────────────────

async function pm2StopAll(): Promise<void> {
  // Stop all processes except telegram-bot itself so we keep receiving commands
  await execAsync(`${PM2} stop all --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 stop all failed:', err.message)
  )
}

async function pm2RestartAll(): Promise<void> {
  await execAsync(`${PM2} restart all --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 restart all failed:', err.message)
  )
}

// ─── Tick helper ─────────────────────────────────────────────────────────────

function withTickTimeout(fn: () => Promise<string>, name: string): Promise<string> {
  return Promise.race([
    fn(),
    new Promise<string>(resolve =>
      setTimeout(() => resolve(`⏱️ ${name}: timeout (${TICK_TIMEOUT_MS / 1000}s)`), TICK_TIMEOUT_MS)
    ),
  ])
}

// ─── Command handlers ─────────────────────────────────────────────────────

async function handleStop() {
  await reply('🛑 *EMERGENCY STOP initiated...*')

  // 1. Disable bot in DB so workers gate on next tick
  await setBotState({ enabled: false })

  // 2. Close all open LP positions
  const supabase = createServerClient()
  const { data: lpPositions } = await supabase
    .from('lp_positions')
    .select('id, symbol, status')
    .in('status', ['active', 'out_of_range'])

  let lpClosed = 0
  for (const pos of lpPositions ?? []) {
    try {
      const ok = await closePosition(pos.id, 'emergency_stop')
      if (ok) lpClosed++
    } catch (err) {
      console.error(`[telegram-bot] emergency close LP ${pos.id} failed:`, err)
    }
  }

  // 3. Close all open spot positions (mark closed_manual — spot-monitor picks up on next tick if still running)
  const { data: spotPositions } = await supabase
    .from('spot_positions')
    .select('id, symbol')
    .eq('status', 'open')

  let spotClosed = 0
  for (const pos of spotPositions ?? []) {
    const { error } = await supabase
      .from('spot_positions')
      .update({ status: 'closed_manual', closed_at: new Date().toISOString() })
      .eq('id', pos.id)
    if (!error) spotClosed++
  }

  // 4. Stop all PM2 processes (telegram-bot stays alive to receive /restart)
  await pm2StopAll()

  await reply([
    `🛑 *Emergency stop complete.*`,
    ``,
    `• LP positions closed: ${lpClosed}/${(lpPositions ?? []).length}`,
    `• Spot positions marked closed: ${spotClosed}/${(spotPositions ?? []).length}`,
    `• All PM2 services stopped (telegram-bot stays alive)`,
    ``,
    `Send /restart to resume all services.`,
  ].join('\n'))
}

async function handleRestart() {
  await reply('⏳ *Restarting all services...*')

  // 1. Re-enable bot in DB
  await setBotState({ enabled: true })

  // 2. Restart all PM2 processes
  await pm2RestartAll()

  const state = await getBotState()
  await reply([
    `✅ *All services restarted.*`,
    `Mode: ${state.dry_run ? '🟡 Dry-run (no real trades)' : '🟢 Live trading'}`,
    `Send /status for a full snapshot.`,
  ].join('\n'))
}

async function handleDry() {
  await setBotState({ dry_run: true })
  await reply('🟡 *Dry-run mode enabled.* No real on-chain transactions will be sent.')
}

async function handleLive() {
  await setBotState({ dry_run: false })
  await reply([
    `🟢 *Live trading enabled.*`,
    `⚠️ Real SOL transactions will be sent when a candidate qualifies.`,
    `Send /dry at any time to revert.`,
  ].join('\n'))
}

async function handleClose(positionId: string) {
  if (!positionId) {
    await reply('❌ Usage: `/close <position_id>`')
    return
  }
  await reply(`⏳ Closing LP position \`${positionId}\`...`)
  try {
    const supabase = createServerClient()
    const { data: pos, error } = await supabase
      .from('lp_positions')
      .select('id, symbol, status')
      .eq('id', positionId)
      .single()
    if (error || !pos) {
      await reply(`❌ LP position \`${positionId}\` not found.`)
      return
    }
    if (pos.status === 'closed') {
      await reply(`ℹ️ \`${positionId}\` (${pos.symbol}) is already closed.`)
      return
    }
    const ok = await closePosition(positionId, 'manual_telegram')
    if (ok) {
      await reply(`✅ \`${positionId}\` (${pos.symbol}) closed successfully.`)
    } else {
      await reply(`❌ Failed to close \`${positionId}\` — check PM2 logs.`)
    }
  } catch (err) {
    await reply(`❌ Close error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleCloseSpot(positionId: string) {
  if (!positionId) {
    await reply('❌ Usage: `/closespot <position_id>`')
    return
  }
  await reply(`⏳ Closing spot position \`${positionId}\`...`)
  try {
    const supabase = createServerClient()
    const { data: pos, error } = await supabase
      .from('spot_positions')
      .select('id, symbol, status')
      .eq('id', positionId)
      .single()
    if (error || !pos) {
      await reply(`❌ Spot position \`${positionId}\` not found.`)
      return
    }
    if (pos.status !== 'open') {
      await reply(`ℹ️ \`${positionId}\` (${pos.symbol}) is already closed (status=${pos.status}).`)
      return
    }
    const { error: updateErr } = await supabase
      .from('spot_positions')
      .update({ status: 'closed_manual', closed_at: new Date().toISOString() })
      .eq('id', positionId)
    if (updateErr) {
      await reply(`❌ DB update failed: ${updateErr.message}`)
      return
    }
    await reply(`✅ \`${positionId}\` (${pos.symbol}) marked closed.`)
  } catch (err) {
    await reply(`❌ CloseSpot error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleStatus() {
  try {
    const supabase = createServerClient()
    const [stateRes, lpRes, spotRes, pm2Res] = await Promise.allSettled([
      getBotState(),
      supabase.from('lp_positions').select('id, symbol, status, sol_deposited')
        .in('status', ['active', 'out_of_range']),
      supabase.from('spot_positions').select('id, symbol, amount_sol, status')
        .eq('status', 'open'),
      execAsync(`${PM2} jlist`),
    ])

    const state    = stateRes.status === 'fulfilled' ? stateRes.value    : { enabled: false, dry_run: true }
    const lpRows   = lpRes.status    === 'fulfilled' ? (lpRes.value.data   ?? []) : []
    const spotRows = spotRes.status  === 'fulfilled' ? (spotRes.value.data ?? []) : []

    const lpSol   = lpRows.reduce((s: number,   r: { sol_deposited?: number }) => s + (r.sol_deposited ?? 0), 0)
    const spotSol = spotRows.reduce((s: number, r: { amount_sol?: number })    => s + (r.amount_sol    ?? 0), 0)

    // Parse PM2 status
    let pm2Summary = 'unknown'
    if (pm2Res.status === 'fulfilled') {
      try {
        const procs = JSON.parse(pm2Res.value.stdout) as Array<{ name: string; pm2_env: { status: string } }>
        const running = procs.filter(p => p.pm2_env.status === 'online').map(p => p.name)
        const stopped = procs.filter(p => p.pm2_env.status !== 'online').map(p => p.name)
        pm2Summary = running.length > 0
          ? `${running.length} running: ${running.join(', ')}`
          : `all stopped`
        if (stopped.length > 0 && running.length > 0)
          pm2Summary += `\nStopped: ${stopped.join(', ')}`
      } catch { pm2Summary = 'parse error' }
    }

    await reply([
      `📊 *Bot Status*`,
      ``,
      `State:   ${state.enabled ? '✅ Running' : '🛑 Stopped'}`,
      `Mode:    ${state.dry_run ? '🟡 Dry-run' : '🟢 Live'}`,
      `PM2:     ${pm2Summary}`,
      ``,
      `LP positions:   ${lpRows.length} open (${lpSol.toFixed(3)} SOL deployed)`,
      `Spot positions: ${spotRows.length} open (${spotSol.toFixed(3)} SOL deployed)`,
      `Total deployed: ${(lpSol + spotSol).toFixed(3)} SOL`,
      ``,
      `Use /positions for LP details, /spots for spot details.`,
    ].join('\n'))
  } catch (err) {
    await reply(`❌ Status error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handlePositions() {
  try {
    const supabase = createServerClient()
    const { data, error } = await supabase
      .from('lp_positions')
      .select('id, symbol, status, sol_deposited, pool_address, opened_at')
      .in('status', ['active', 'out_of_range'])
      .order('opened_at', { ascending: false })
      .limit(10)

    if (error) { await reply(`❌ DB error: ${error.message}`); return }
    const rows = data ?? []
    if (rows.length === 0) { await reply('📭 No open LP positions.'); return }

    const lines = rows.map((r: { id: string; symbol: string; status: string; sol_deposited?: number; pool_address?: string; opened_at: string }) => {
      const age  = ((Date.now() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1)
      const pool = r.pool_address ? r.pool_address.slice(0, 8) + '...' : 'unknown'
      return `• \`${r.id.slice(0, 8)}\` *${r.symbol}* — ${r.status} | ${(r.sol_deposited ?? 0).toFixed(3)} SOL | pool=${pool} | ${age}h\n  /close ${r.id}`
    })

    await reply([`🏊 *Open LP Positions (${rows.length})*`, '', ...lines].join('\n'))
  } catch (err) {
    await reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleSpots() {
  try {
    const supabase = createServerClient()
    const { data, error } = await supabase
      .from('spot_positions')
      .select('id, symbol, amount_sol, status, opened_at')
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .limit(10)

    if (error) { await reply(`❌ DB error: ${error.message}`); return }
    const rows = data ?? []
    if (rows.length === 0) { await reply('📭 No open spot positions.'); return }

    const lines = rows.map((r: { id: string; symbol: string; amount_sol?: number; opened_at: string }) => {
      const age = ((Date.now() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1)
      return `• \`${r.id.slice(0, 8)}\` *${r.symbol}* — ${(r.amount_sol ?? 0).toFixed(3)} SOL | ${age}h\n  /closespot ${r.id}`
    })

    await reply([`🎯 *Open Spot Positions (${rows.length})*`, '', ...lines].join('\n'))
  } catch (err) {
    await reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleTick() {
  await reply('⚡ *Manual tick triggered* — running all pipelines in parallel...')

  const started = Date.now()

  const [lpScanResult, lpMonitorResult, preGradResult, spotMonitorResult, lpMigratorResult] =
    await Promise.all([
      withTickTimeout(
        async () => {
          const r = await runScanner()
          return `✅ lp-scanner: scanned=${r.scanned} candidates=${r.candidates} opened=${r.opened}`
        },
        'lp-scanner',
      ),
      withTickTimeout(
        async () => {
          const r = await monitorPositions()
          return `✅ lp-monitor: checked=${r.checked} closed=${r.closed} rebalanced=${r.rebalanced}`
        },
        'lp-monitor',
      ),
      withTickTimeout(runPreGradScanner, 'pre-grad-scanner'),
      withTickTimeout(runSpotMonitor,    'spot-monitor'),
      withTickTimeout(runLpMigrator,     'lp-migrator'),
    ])

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  await reply([
    `📋 *Tick complete* (${elapsed}s)`,
    ``,
    lpScanResult,
    lpMonitorResult,
    preGradResult,
    spotMonitorResult,
    lpMigratorResult,
  ].join('\n'))
}

async function handleHelp() {
  await reply([
    `🤖 *Meteoracle Commands*`,
    ``,
    `*Control*`,
    `/stop          — 🛑 Emergency: close all positions + stop all services`,
    `/restart       — ▶️ Resume: restart all PM2 services`,
    `/dry           — dry-run mode (no real trades)`,
    `/live          — live trading ⚠️`,
    `/tick          — manual trigger all pipelines`,
    ``,
    `*Positions*`,
    `/positions     — list open Meteora LP positions`,
    `/spots         — list open pre-grad spot positions`,
    `/close <id>    — force-close an LP position`,
    `/closespot <id> — force-close a spot position`,
    ``,
    `*Info*`,
    `/status        — state + PM2 status + deployed SOL snapshot`,
    `/help          — this message`,
  ].join('\n'))
}

// ─── Main poll loop ─────────────────────────────────────────────────────────────

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.text) return
  if (String(msg.chat.id) !== String(CHAT_ID)) return

  const parts   = msg.text.trim().split(/\s+/)
  const command = parts[0].toLowerCase()

  console.log(`[telegram-bot] command: ${command}`)

  if      (command === '/stop')      await handleStop()
  else if (command === '/restart')   await handleRestart()
  else if (command === '/start')     await handleRestart()  // alias for muscle memory
  else if (command === '/dry')       await handleDry()
  else if (command === '/live')      await handleLive()
  else if (command === '/close')     await handleClose(parts[1] ?? '')
  else if (command === '/closespot') await handleCloseSpot(parts[1] ?? '')
  else if (command === '/status')    await handleStatus()
  else if (command === '/positions') await handlePositions()
  else if (command === '/spots')     await handleSpots()
  else if (command === '/tick')      await handleTick()
  else if (command === '/help')      await handleHelp()
  else await reply(`❓ Unknown command. Send /help for the list.`)
}

async function poll(): Promise<void> {
  const updates = await getUpdates()
  for (const update of updates) {
    if (update.update_id > lastUpdateId) {
      lastUpdateId = update.update_id
      await handleUpdate(update).catch(err =>
        console.error('[telegram-bot] handler error:', err)
      )
    }
  }
}

async function main(): Promise<void> {
  console.log(`[telegram-bot] starting — polling every ${POLL_MS}ms`)
  await reply('🤖 *Meteoracle bot online.* Send /help for commands.')
  await poll()
  setInterval(poll, POLL_MS)
}

main().catch(err => {
  console.error('[telegram-bot] fatal:', err)
  process.exit(1)
})
