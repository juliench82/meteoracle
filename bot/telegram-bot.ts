/**
 * telegram-bot.ts
 *
 * Standalone Telegram command bot using long-polling (getUpdates).
 * No webhook, no HTTPS, no Vercel needed — runs as a PM2 process on the VPS.
 *
 * Commands:
 *   /stop              — EMERGENCY: close all positions + pm2 stop workers (bot stays alive)
 *   /restart           — resume: setBotState enabled + pm2 restart workers
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
import { sellTokenForSol } from '@/bot/spot-seller'

const execAsync = promisify(exec)
const PM2 = '/usr/local/bin/pm2'

const WORKER_PROCESSES = [
  'lp-scanner',
  'lp-monitor-dlmm',
  'scanner',
  'buyer',
  'monitor',
  'migrator',
  'lp-monitor',
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

// ─── Telegram helpers ────────────────────────────────────────────────────────────────────────────────────

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

// ─── PM2 helpers ──────────────────────────────────────────────────────────────────────────────────────

async function pm2StopWorkers(): Promise<void> {
  const names = WORKER_PROCESSES.join(' ')
  await execAsync(`${PM2} stop ${names} --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 stop workers failed:', err.message)
  )
}

async function pm2RestartWorkers(): Promise<void> {
  const names = WORKER_PROCESSES.join(' ')
  await execAsync(`${PM2} restart ${names} --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 restart workers failed:', err.message)
  )
}

// ─── Tick helper ────────────────────────────────────────────────────────────────────────────────────

function withTickTimeout(fn: () => Promise<string>, name: string): Promise<string> {
  return Promise.race([
    fn(),
    new Promise<string>(resolve =>
      setTimeout(() => resolve(`⏱️ ${name}: timeout (${TICK_TIMEOUT_MS / 1000}s)`), TICK_TIMEOUT_MS)
    ),
  ])
}

// ─── Price helper (for P&L on manual close) ────────────────────────────────────────────────────────────────────

async function fetchCurrentPriceUsd(mint: string): Promise<number> {
  try {
    const res = await axios.get('https://api.jup.ag/price/v2', {
      params: { ids: mint }, timeout: 8_000,
    })
    const price = parseFloat(res.data?.data?.[mint]?.price ?? '0')
    if (price > 0) return price
  } catch {}
  try {
    const res = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      timeout: 8_000, headers: { 'User-Agent': 'meteoracle-bot/1.0' },
    })
    const usdMc  = parseFloat(res.data?.usd_market_cap ?? '0')
    const supply = parseFloat(res.data?.total_supply    ?? '0')
    if (usdMc > 0 && supply > 0) return usdMc / supply
  } catch {}
  return 0
}

// ─── Command handlers ─────────────────────────────────────────────────────────────────────────────────

async function handleStop() {
  await reply('🛑 *EMERGENCY STOP initiated...*')

  await setBotState({ enabled: false })

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

  const { data: spotPositions } = await supabase
    .from('spot_positions')
    .select('id, symbol, mint, amount_sol, token_amount, entry_price_usd, entry_price_sol, dry_run')
    .eq('status', 'open')

  let spotClosed = 0
  const closedAt = new Date().toISOString()

  for (const pos of spotPositions ?? []) {
    // Attempt to fetch current price for P&L estimate
    const currentPriceUsd = await fetchCurrentPriceUsd(pos.mint)
    let pnlSol: number | null = null
    let pnlPct: number | null = null

    if (currentPriceUsd > 0 && pos.entry_price_usd > 0) {
      const mult = currentPriceUsd / pos.entry_price_usd
      pnlSol     = parseFloat((pos.amount_sol * (mult - 1)).toFixed(6))
      pnlPct     = parseFloat(((mult - 1) * 100).toFixed(2))
    }

    const { error } = await supabase
      .from('spot_positions')
      .update({
        status:    'closed_manual',
        closed_at: closedAt,
        ...(pnlSol !== null ? { pnl_sol: pnlSol, pnl_pct: pnlPct } : {}),
      })
      .eq('id', pos.id)

    if (!error) spotClosed++
  }

  await pm2StopWorkers()

  await reply([
    `🛑 *Emergency stop complete.*`,
    ``,
    `• LP positions closed: ${lpClosed}/${(lpPositions ?? []).length}`,
    `• Spot positions marked closed: ${spotClosed}/${(spotPositions ?? []).length}`,
    `• All worker services stopped (telegram-bot alive ✅)`,
    ``,
    `Send /restart to resume all services.`,
  ].join('\n'))
}

async function handleRestart() {
  await reply('⏳ *Restarting worker services...*')

  await setBotState({ enabled: true })

  await pm2RestartWorkers()

  const state = await getBotState()
  await reply([
    `✅ *All worker services restarted.*`,
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

async function handleCloseSpot(positionId: string) {
  if (!positionId) { await reply('❌ Usage: `/closespot <position_id>`'); return }
  await reply(`⏳ Closing spot position \`${positionId}\`...`)

  try {
    const supabase = createServerClient()
    const { data: pos, error } = await supabase
      .from('spot_positions')
      .select('id, symbol, mint, status, dry_run, token_amount, amount_sol, entry_price_sol, entry_price_usd')
      .eq('id', positionId)
      .single()

    if (error || !pos) { await reply(`❌ Spot position \`${positionId}\` not found.`); return }
    if (pos.status !== 'open') { await reply(`ℹ️ \`${positionId}\` (${pos.symbol}) already closed (status=${pos.status}).`); return }

    const dexUrl    = `https://dexscreener.com/solana/${pos.mint}`
    const closedAt  = new Date().toISOString()
    const state     = await getBotState()
    const isRealSell = !state.dry_run && !pos.dry_run && pos.token_amount > 0

    if (isRealSell) {
      // ── LIVE SELL ──
      const sellResult = await sellTokenForSol(
        pos.mint, pos.token_amount, 6, pos.symbol,
      )

      if (!sellResult.success) {
        await reply(`❌ Sell tx failed for ${pos.symbol}: ${sellResult.error}`)
        return
      }

      const solReceived   = sellResult.solReceived ?? 0
      const pnlSol        = solReceived - pos.amount_sol
      const exitPriceSol  = pos.token_amount > 0 ? solReceived / pos.token_amount : 0
      const pnlPct        = pos.amount_sol > 0 ? (pnlSol / pos.amount_sol) * 100 : 0
      const pnlStr        = `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`

      await supabase.from('spot_positions').update({
        status:         'closed_manual',
        closed_at:      closedAt,
        exit_price_sol: exitPriceSol,
        pnl_sol:        pnlSol,
        pnl_pct:        parseFloat(pnlPct.toFixed(2)),
        tx_sell:        sellResult.txSignature ?? null,
      }).eq('id', positionId)

      await reply([
        `✅ *CLOSED ${pos.symbol}* (manual)`,
        `💰 PnL: ${pnlStr}`,
        `🧳 SOL received: ${solReceived.toFixed(4)}`,
        `📈 ${dexUrl}`,
      ].join('\n'))

    } else {
      // ── DRY-RUN / no tokens — fetch current price for P&L estimate ──
      const currentPriceUsd = await fetchCurrentPriceUsd(pos.mint)
      let pnlSol    = 0
      let pnlPct    = 0
      let exitPrice = 0

      if (currentPriceUsd > 0 && pos.entry_price_usd > 0) {
        const mult   = currentPriceUsd / pos.entry_price_usd
        pnlSol       = pos.amount_sol * (mult - 1)
        pnlPct       = (mult - 1) * 100
        exitPrice    = pos.entry_price_sol * mult
      }

      const pnlStr = pnlSol !== 0
        ? `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`
        : 'n/a (price unavailable)'

      await supabase.from('spot_positions').update({
        status:         'closed_manual',
        closed_at:      closedAt,
        exit_price_sol: exitPrice,
        pnl_sol:        pnlSol,
        pnl_pct:        parseFloat(pnlPct.toFixed(2)),
      }).eq('id', positionId)

      await reply([
        `✅ *CLOSED ${pos.symbol}* (dry-run / manual)`,
        `💰 Est. PnL: ${pnlStr}`,
        `📈 ${dexUrl}`,
      ].join('\n'))
    }
  } catch (err) {
    await reply(`❌ Close error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleStatus() {
  const supabase = createServerClient()
  const state    = await getBotState()

  const [{ data: openSpot }, { data: openLp }] = await Promise.all([
    supabase.from('spot_positions').select('id, symbol, amount_sol, opened_at').eq('status', 'open'),
    supabase.from('lp_positions').select('id, symbol, sol_deposited, opened_at').in('status', ['active', 'out_of_range']),
  ])

  const spotLines = (openSpot ?? []).map(p => {
    const mins = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000)
    return `  • ${p.symbol} — ${p.amount_sol.toFixed(3)} SOL | ${mins}min`
  })

  const lpLines = (openLp ?? []).map(p => {
    const mins = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000)
    return `  • ${p.symbol} — ${(p.sol_deposited ?? 0).toFixed(3)} SOL | ${mins}min`
  })

  const lines = [
    `🤖 *Bot Status*`,
    `State: ${state.enabled ? '🟢 Running' : '🛑 Stopped'}`,
    `Mode:  ${state.dry_run ? '🟡 Dry-run' : '🟢 Live'}`,
    ``,
    `🎯 Spot Positions (${(openSpot ?? []).length})`,
    ...(spotLines.length ? spotLines : ['  none']),
    ``,
    `🏊 LP Positions (${(openLp ?? []).length})`,
    ...(lpLines.length ? lpLines : ['  none']),
  ]

  await reply(lines.join('\n'))
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
      `• ${p.id.slice(0, 8)} ${p.symbol} — ${p.status} | ${(p.sol_deposited ?? 0).toFixed(3)} SOL | pool=${(p.pool_address ?? 'n/a').slice(0, 8)}... | ${age}h`,
      `  /close ${p.id}`
    )
  }
  await reply(lines.join('\n'))
}

async function handleSpots() {
  const supabase = createServerClient()
  const { data } = await supabase
    .from('spot_positions')
    .select('id, symbol, amount_sol, opened_at')
    .eq('status', 'open')
    .order('opened_at', { ascending: false })

  if (!data || data.length === 0) {
    await reply('🎯 No open spot positions.')
    return
  }

  const lines = [`🎯 *Open Spot Positions (${data.length})*`, ``]
  for (const p of data) {
    const age = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 3_600_000 * 10) / 10
    lines.push(
      `• ${p.id.slice(0, 8)} ${p.symbol} — ${p.amount_sol.toFixed(3)} SOL | ${age}h`,
      `  /closespot ${p.id}`
    )
  }
  await reply(lines.join('\n'))
}

async function handleTick() {
  await reply('⏳ *Running all pipelines in parallel...*')

  const results = await Promise.all([
    withTickTimeout(() => runScanner().then(r => typeof r === 'string' ? r : '✅ scanner done'), 'scanner'),
    withTickTimeout(() => monitorPositions().then(r => typeof r === 'string' ? r : '✅ monitor done'), 'monitor'),
    withTickTimeout(() => runPreGradScanner().then(r => typeof r === 'string' ? r : '✅ pre-grad-scanner done'), 'pre-grad-scanner'),
    withTickTimeout(() => runSpotMonitor(), 'spot-monitor'),
    withTickTimeout(() => runLpMigrator().then(r => typeof r === 'string' ? r : '✅ lp-migrator done'), 'lp-migrator'),
  ])

  await reply(['*Tick complete:*', ...results.map(r => `• ${r}`)].join('\n'))
}

async function handleHelp() {
  await reply([
    `*Meteoracle Bot Commands*`,
    ``,
    `/stop — emergency stop (closes all positions, stops workers)`,
    `/restart — resume all worker services`,
    `/dry — switch to dry-run mode`,
    `/live — switch to live trading`,
    `/status — snapshot of bot state + open positions`,
    `/positions — list all open LP positions`,
    `/spots — list all open spot positions`,
    `/close <id> — force-close an LP position`,
    `/closespot <id> — force-close a spot position`,
    `/tick — manually trigger all pipelines`,
    `/help — this message`,
  ].join('\n'))
}

// ─── Main poll loop ────────────────────────────────────────────────────────────────────────────────────

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const text = update.message?.text?.trim() ?? ''
  const chatId = update.message?.chat?.id

  if (!text || String(chatId) !== CHAT_ID) return

  const [rawCmd, ...args] = text.split(/\s+/)
  const cmd = rawCmd.toLowerCase().replace(/^\//,'')

  console.log(`[telegram-bot] command: /${cmd}${args.length ? ' ' + args.join(' ') : ''}`)

  switch (cmd) {
    case 'stop':      await handleStop();                break
    case 'restart':   await handleRestart();             break
    case 'dry':       await handleDry();                 break
    case 'live':      await handleLive();                break
    case 'close':     await handleClose(args[0] ?? '');  break
    case 'closespot': await handleCloseSpot(args[0] ?? ''); break
    case 'status':    await handleStatus();              break
    case 'positions': await handlePositions();           break
    case 'spots':     await handleSpots();               break
    case 'tick':      await handleTick();                break
    case 'help':      await handleHelp();                break
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
