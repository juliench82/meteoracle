/**
 * telegram-bot.ts
 *
 * Standalone Telegram command bot using long-polling (getUpdates).
 * No webhook, no HTTPS, no Vercel needed — runs as a PM2 process on the VPS.
 *
 * Commands:
 *   /stop              — pause all scanning & monitoring
 *   /start             — resume the bot
 *   /dry               — switch to dry-run mode
 *   /live              — switch to live trading
 *   /close <id>        — force-close an LP position by ID
 *   /closespot <id>    — force-close a spot position by ID
 *   /status            — snapshot: state, open positions, wallet SOL
 *   /positions         — list all open LP positions
 *   /spots             — list all open spot positions
 *   /help              — command list
 *
 * Run:
 *   npx tsx bot/telegram-bot.ts
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { getBotState, setBotState } from '@/lib/botState'
import { closePosition } from '@/bot/executor'

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN ?? ''
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID   ?? ''
const POLL_MS     = 2_000
const API         = `https://api.telegram.org/bot${BOT_TOKEN}`

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — exiting')
  process.exit(1)
}

let lastUpdateId = 0

// ─── Telegram helpers ────────────────────────────────────────────────────────

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

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleStop() {
  await setBotState({ enabled: false })
  await reply([
    `🛑 *Bot stopped.*`,
    `• Scanner and monitor will skip new ticks`,
    `• Open positions will NOT be auto-managed while stopped`,
    `• Send /start to resume`,
  ].join('\n'))
}

async function handleStart() {
  await setBotState({ enabled: true })
  const state = await getBotState()
  await reply([
    `✅ *Bot started.*`,
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
      .from('positions')
      .select('id, token_symbol, status')
      .eq('id', positionId)
      .single()
    if (error || !pos) {
      await reply(`❌ Position \`${positionId}\` not found.`)
      return
    }
    if (pos.status === 'closed') {
      await reply(`ℹ️ \`${positionId}\` (${pos.token_symbol}) is already closed.`)
      return
    }
    const ok = await closePosition(positionId, 'manual_telegram')
    if (ok) {
      await reply(`✅ \`${positionId}\` (${pos.token_symbol}) closed successfully.`)
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
      .select('id, symbol, status, mint, token_amount, dry_run')
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
    // Mark as manually closed in DB — spot-seller handles actual sell
    const { error: updateErr } = await supabase
      .from('spot_positions')
      .update({ status: 'closed_manual', closed_at: new Date().toISOString() })
      .eq('id', positionId)
    if (updateErr) {
      await reply(`❌ DB update failed: ${updateErr.message}`)
      return
    }
    await reply(`✅ \`${positionId}\` (${pos.symbol}) marked closed. Spot-seller will execute the sell on next tick.`)
  } catch (err) {
    await reply(`❌ CloseSpot error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleStatus() {
  try {
    const supabase = createServerClient()
    const [stateRes, lpRes, spotRes] = await Promise.allSettled([
      getBotState(),
      supabase.from('positions').select('id, token_symbol, status, sol_deposited, fees_earned_sol')
        .in('status', ['active', 'out_of_range']),
      supabase.from('spot_positions').select('id, symbol, amount_sol, status')
        .eq('status', 'open'),
    ])

    const state     = stateRes.status    === 'fulfilled' ? stateRes.value    : { enabled: false, dry_run: true }
    const lpRows    = lpRes.status       === 'fulfilled' ? (lpRes.value.data ?? [])   : []
    const spotRows  = spotRes.status     === 'fulfilled' ? (spotRes.value.data ?? []) : []

    const lpSol     = lpRows.reduce((s: number, r: { sol_deposited?: number }) => s + (r.sol_deposited ?? 0), 0)
    const spotSol   = spotRows.reduce((s: number, r: { amount_sol?: number }) => s + (r.amount_sol ?? 0), 0)
    const totalSol  = lpSol + spotSol

    await reply([
      `📊 *Bot Status*`,
      ``,
      `State:   ${state.enabled ? '✅ Running' : '🛑 Stopped'}`,
      `Mode:    ${state.dry_run ? '🟡 Dry-run' : '🟢 Live'}`,
      ``,
      `LP positions:   ${lpRows.length} open (${lpSol.toFixed(3)} SOL deployed)`,
      `Spot positions: ${spotRows.length} open (${spotSol.toFixed(3)} SOL deployed)`,
      `Total deployed: ${totalSol.toFixed(3)} SOL`,
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
      .from('positions')
      .select('id, token_symbol, status, sol_deposited, fees_earned_sol, opened_at')
      .in('status', ['active', 'out_of_range'])
      .order('opened_at', { ascending: false })
      .limit(10)

    if (error) { await reply(`❌ DB error: ${error.message}`); return }
    const rows = data ?? []
    if (rows.length === 0) { await reply('📭 No open LP positions.'); return }

    const lines = rows.map((r: { id: string; token_symbol: string; status: string; sol_deposited?: number; fees_earned_sol?: number; opened_at: string }) => {
      const age = ((Date.now() - new Date(r.opened_at).getTime()) / 3_600_000).toFixed(1)
      const fees = (r.fees_earned_sol ?? 0).toFixed(4)
      return `• \`${r.id.slice(0, 8)}\` *${r.token_symbol}* — ${r.status} | ${(r.sol_deposited ?? 0).toFixed(3)} SOL | fees=${fees} SOL | ${age}h\n  /close ${r.id}`
    })

    await reply([`📂 *Open LP Positions (${rows.length})*`, '', ...lines].join('\n'))
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

async function handleHelp() {
  await reply([
    `🤖 *Meteoracle Commands*`,
    ``,
    `*Control*`,
    `/stop          — pause scanner & monitor`,
    `/start         — resume the bot`,
    `/dry           — dry-run mode (no real trades)`,
    `/live          — live trading ⚠️`,
    ``,
    `*Positions*`,
    `/positions     — list open LP positions`,
    `/spots         — list open spot positions`,
    `/close <id>    — force-close an LP position`,
    `/closespot <id> — force-close a spot position`,
    ``,
    `*Info*`,
    `/status        — state + deployed SOL snapshot`,
    `/help          — this message`,
  ].join('\n'))
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg?.text) return

  // Security: only respond to your own chat
  if (String(msg.chat.id) !== String(CHAT_ID)) return

  const parts   = msg.text.trim().split(/\s+/)
  const command = parts[0].toLowerCase()

  console.log(`[telegram-bot] command: ${command}`)

  if      (command === '/stop')      await handleStop()
  else if (command === '/start')     await handleStart()
  else if (command === '/dry')       await handleDry()
  else if (command === '/live')      await handleLive()
  else if (command === '/close')     await handleClose(parts[1] ?? '')
  else if (command === '/closespot') await handleCloseSpot(parts[1] ?? '')
  else if (command === '/status')    await handleStatus()
  else if (command === '/positions') await handlePositions()
  else if (command === '/spots')     await handleSpots()
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
