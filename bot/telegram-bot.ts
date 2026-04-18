/**
 * telegram-bot.ts
 *
 * Standalone Telegram command bot using long-polling (getUpdates).
 * No webhook, no HTTPS needed — runs as a PM2 process on the VPS.
 *
 * Commands:
 *   /stop        — EMERGENCY: close all LP positions + pm2 stop workers
 *   /restart     — resume: setBotState enabled + pm2 restart workers
 *   /dry         — switch to dry-run mode
 *   /live        — switch to live trading
 *   /close <id>  — force-close an LP position by ID
 *   /positions   — list all open LP positions
 *   /status      — snapshot: state, open positions, wallet SOL
 *   /tick        — manually trigger scanner + monitor in parallel
 *   /help        — command list
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

const execAsync = promisify(exec)
const PM2 = '/usr/local/bin/pm2'

const WORKER_PROCESSES = [
  'lp-scanner',
  'lp-monitor-dlmm',
  'dashboard',
]

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

// ─── Telegram helpers ─────────────────────────────────────────────────────────────────────────────────────

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

async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
  try {
    const res = await axios.get(`${API}/getUpdates`, {
      params: { offset: offset ?? lastUpdateId + 1, timeout: 10, limit: 100 },
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

async function drainPendingUpdates(): Promise<void> {
  console.log('[telegram-bot] draining stale updates...')
  const updates = await getUpdates()
  if (updates.length > 0) {
    lastUpdateId = updates[updates.length - 1].update_id
    await getUpdates(lastUpdateId + 1)
    console.log(`[telegram-bot] drained ${updates.length} stale update(s), resuming from id=${lastUpdateId}`)
  } else {
    console.log('[telegram-bot] no stale updates')
  }
}

// ─── PM2 helpers ──────────────────────────────────────────────────────────────────────────────────────────

async function pm2StopWorkers(): Promise<void> {
  const names = WORKER_PROCESSES.join(' ')
  await execAsync(`${PM2} stop ${names} --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 stop failed:', err.message)
  )
}

async function pm2RestartWorkers(): Promise<void> {
  const names = WORKER_PROCESSES.join(' ')
  await execAsync(`${PM2} restart ${names} --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 restart failed:', err.message)
  )
}

// ─── Tick helper ──────────────────────────────────────────────────────────────────────────────────────

function withTickTimeout(fn: () => Promise<string>, name: string): Promise<string> {
  return Promise.race([
    fn(),
    new Promise<string>(resolve =>
      setTimeout(() => resolve(`⏱️ ${name}: timeout (${TICK_TIMEOUT_MS / 1000}s)`), TICK_TIMEOUT_MS)
    ),
  ])
}

// ─── Command handlers ─────────────────────────────────────────────────────────────────────────────────

async function handleStop() {
  await reply('🛑 *EMERGENCY STOP initiated...*')
  await setBotState({ enabled: false })

  const supabase = createServerClient()
  const { data: positions } = await supabase
    .from('lp_positions')
    .select('id, symbol, status')
    .in('status', ['active', 'out_of_range'])

  let closed = 0
  for (const pos of positions ?? []) {
    try {
      const ok = await closePosition(pos.id, 'emergency_stop')
      if (ok) closed++
    } catch (err) {
      console.error(`[telegram-bot] emergency close ${pos.id} failed:`, err)
    }
  }

  await pm2StopWorkers()

  await reply([
    `🛑 *Emergency stop complete.*`,
    ``,
    `• LP positions closed: ${closed}/${(positions ?? []).length}`,
    `• Worker services stopped (telegram-bot alive ✅)`,
    ``,
    `Send /restart to resume.`,
  ].join('\n'))
}

async function handleRestart() {
  await reply('⏳ *Restarting worker services...*')
  await setBotState({ enabled: true })
  await pm2RestartWorkers()
  const state = await getBotState()
  await reply([
    `✅ *All worker services restarted.*`,
    `Mode: ${state.dry_run ? '🟡 Dry-run' : '🟢 Live trading'}`,
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
  if (!positionId) { await reply('❌ Usage: `/close <position_id>`'); return }
  await reply(`⏳ Closing LP position \`${positionId}\`...`)
  try {
    const supabase = createServerClient()
    const { data: pos, error } = await supabase
      .from('lp_positions').select('id, symbol, status').eq('id', positionId).single()
    if (error || !pos) { await reply(`❌ LP position \`${positionId}\` not found.`); return }
    if (pos.status === 'closed') { await reply(`ℹ️ \`${positionId}\` (${pos.symbol}) is already closed.`); return }
    const ok = await closePosition(positionId, 'manual_telegram')
    await reply(ok
      ? `✅ \`${positionId}\` (${pos.symbol}) closed successfully.`
      : `❌ Failed to close \`${positionId}\` — check PM2 logs.`
    )
  } catch (err) {
    await reply(`❌ Close error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleStatus() {
  const supabase = createServerClient()
  const state    = await getBotState()

  const { data: openLp } = await supabase
    .from('lp_positions')
    .select('id, symbol, sol_deposited, opened_at')
    .in('status', ['active', 'out_of_range'])

  const lpLines = (openLp ?? []).map(p => {
    const mins = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000)
    return `  • ${p.symbol} — ${(p.sol_deposited ?? 0).toFixed(3)} SOL | ${mins}min`
  })

  await reply([
    `🤖 *Bot Status*`,
    `State: ${state.enabled ? '🟢 Running' : '🛑 Stopped'}`,
    `Mode:  ${state.dry_run ? '🟡 Dry-run' : '🟢 Live'}`,
    ``,
    `🏊 LP Positions (${(openLp ?? []).length})`,
    ...(lpLines.length ? lpLines : ['  none']),
  ].join('\n'))
}

async function handlePositions() {
  const supabase = createServerClient()
  const { data } = await supabase
    .from('lp_positions')
    .select('id, symbol, status, sol_deposited, pool_address, opened_at')
    .in('status', ['active', 'out_of_range'])
    .order('opened_at', { ascending: false })

  if (!data || data.length === 0) {
    await reply('🏊 No open LP positions.')
    return
  }

  const lines = [`🏊 *Open LP Positions (${data.length})*`, ``]
  for (const p of data) {
    const age = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 3_600_000 * 10) / 10
    lines.push(
      `• ${p.id.slice(0, 8)} ${p.symbol} — ${p.status} | ${(p.sol_deposited ?? 0).toFixed(3)} SOL | ${age}h`,
      `  /close ${p.id}`
    )
  }
  await reply(lines.join('\n'))
}

async function handleTick() {
  await reply('⏳ *Running scanner + monitor...*')

  const results = await Promise.all([
    withTickTimeout(() => runScanner().then(() => '✅ scanner done'), 'scanner'),
    withTickTimeout(() => monitorPositions().then(() => '✅ monitor done'), 'monitor'),
  ])

  await reply(['*Tick complete:*', ...results.map(r => `• ${r}`)].join('\n'))
}

async function handleHelp() {
  await reply([
    `*Meteoracle Bot Commands*`,
    ``,
    `/stop — emergency stop (closes all LP positions, stops workers)`,
    `/restart — resume all worker services`,
    `/dry — switch to dry-run mode`,
    `/live — switch to live trading`,
    `/status — snapshot of bot state + open LP positions`,
    `/positions — list all open LP positions`,
    `/close <id> — force-close an LP position`,
    `/tick — manually trigger scanner + monitor`,
    `/help — this message`,
  ].join('\n'))
}

// ─── Main poll loop ───────────────────────────────────────────────────────────────────────────────────

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const text   = update.message?.text?.trim() ?? ''
  const chatId = update.message?.chat?.id

  if (!text || String(chatId) !== CHAT_ID) return

  const [rawCmd, ...args] = text.split(/\s+/)
  const cmd = rawCmd.toLowerCase().replace(/^\//, '')

  console.log(`[telegram-bot] command: /${cmd}${args.length ? ' ' + args.join(' ') : ''}`)

  switch (cmd) {
    case 'stop':      await handleStop();               break
    case 'restart':   await handleRestart();            break
    case 'dry':       await handleDry();                break
    case 'live':      await handleLive();               break
    case 'close':     await handleClose(args[0] ?? ''); break
    case 'status':    await handleStatus();             break
    case 'positions': await handlePositions();          break
    case 'tick':      await handleTick();               break
    case 'help':      await handleHelp();               break
    default:
      await reply(`❌ Unknown command: /${cmd}. Send /help for the list.`)
  }
}

async function main(): Promise<void> {
  console.log('[telegram-bot] starting long-poll loop...')
  await drainPendingUpdates()

  while (true) {
    const updates = await getUpdates()
    for (const update of updates) {
      lastUpdateId = update.update_id
      await processUpdate(update)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

main().catch(err => {
  console.error('[telegram-bot] fatal:', err)
  process.exit(1)
})
