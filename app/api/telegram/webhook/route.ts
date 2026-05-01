import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { closePosition, openPosition } from '@/bot/executor'
import { createServerClient } from '@/lib/supabase'
import { getBotState, setBotState } from '@/lib/botState'
import { fetchLiveDlmmPositions } from '@/lib/meteora-live'
import { STRATEGIES } from '@/strategies'
import type { TokenMetrics } from '@/lib/types'
import axios from 'axios'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET

async function reply(chatId: number | string, text: string) {
  if (!TELEGRAM_BOT_TOKEN) return
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 5_000 },
  ).catch(() => {})
}

function logToDB(supabase: ReturnType<typeof createServerClient>, payload: object) {
  void Promise.resolve(supabase.from('bot_logs').insert(payload)).catch(() => {})
}

async function runTick(chatId: number | string) {
  const startedAt = Date.now()
  try {
    const [monitorResult, scanResult] = await Promise.all([
      monitorPositions(),
      runScanner(),
    ])
    const durationMs = Date.now() - startedAt
    logToDB(createServerClient(), {
      level: 'info', event: 'bot_tick',
      payload: { monitor: monitorResult, scanner: scanResult, durationMs, source: 'telegram' },
    })
    await reply(chatId, [
      `✅ *Tick complete* (${durationMs}ms)`,
      `📡 Scanned: ${scanResult.scanned} pairs`,
      `🎯 Candidates: ${scanResult.candidates}`,
      `📂 Opened: ${scanResult.opened} positions`,
      `👁 Monitored: ${monitorResult.checked} positions`,
      `🔒 Closed: ${monitorResult.closed}`,
    ].join('\n'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tick] error:', msg)
    await reply(chatId, `❌ Tick failed: ${msg}`)
  }
}

async function runScanOnly(chatId: number | string) {
  const startedAt = Date.now()
  try {
    const scanResult = await runScanner()
    const durationMs = Date.now() - startedAt
    logToDB(createServerClient(), {
      level: 'info', event: 'bot_scan',
      payload: { scanner: scanResult, durationMs, source: 'telegram' },
    })
    await reply(chatId, [
      `📡 *Scan complete* (${durationMs}ms)`,
      `Scanned: ${scanResult.scanned} pairs`,
      `🎯 Candidates: ${scanResult.candidates}`,
      `📂 Opened: ${scanResult.opened} positions`,
    ].join('\n'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scan] error:', msg)
    await reply(chatId, `❌ Scan failed: ${msg}`)
  }
}

async function runMonitorOnly(chatId: number | string) {
  const startedAt = Date.now()
  try {
    const monitorResult = await monitorPositions()
    const durationMs = Date.now() - startedAt
    logToDB(createServerClient(), {
      level: 'info', event: 'bot_monitor',
      payload: { monitor: monitorResult, durationMs, source: 'telegram' },
    })
    await reply(chatId, [
      `👁 *Monitor complete* (${durationMs}ms)`,
      `Checked: ${monitorResult.checked} positions`,
      `🔒 Closed: ${monitorResult.closed}`,
      `🔄 Rebalanced: ${monitorResult.rebalanced}`,
      `💰 Fee claims logged: ${monitorResult.claimed}`,
    ].join('\n'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[monitor] error:', msg)
    await reply(chatId, `❌ Monitor failed: ${msg}`)
  }
}

function guardBot(state: { enabled: boolean }) {
  return !state.enabled
}

export async function POST(req: Request) {
  try {
    if (!TELEGRAM_WEBHOOK_SECRET) {
      return NextResponse.json(
        { ok: false, error: 'TELEGRAM_WEBHOOK_SECRET is not configured' },
        { status: 500 },
      )
    }
    if (req.headers.get('x-telegram-bot-api-secret-token') !== TELEGRAM_WEBHOOK_SECRET) {
      return NextResponse.json({ ok: false }, { status: 401 })
    }

    const body    = await req.json()
    const message = body?.message
    if (!message) return NextResponse.json({ ok: true })

    const chatId  = message.chat?.id
    const text: string = message.text ?? ''
    const parts   = text.trim().split(/\s+/)
    const command = parts[0].toLowerCase()

    if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /close
    if (command === '/close') {
      const positionId = parts[1]
      if (!positionId) {
        await reply(chatId, '❌ Usage: `/close <position_id>`')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, `⏳ Closing position \`${positionId}\`...`)
      const supabase = createServerClient()
      const { data: pos, error } = await supabase
        .from('lp_positions')
        .select('id, symbol, status')
        .eq('id', positionId)
        .single()
      if (error || !pos) {
        await reply(chatId, `❌ Position \`${positionId}\` not found.`)
        return NextResponse.json({ ok: true })
      }
      if (pos.status === 'closed') {
        await reply(chatId, `ℹ️ Position \`${positionId}\` (${pos.symbol}) is already closed.`)
        return NextResponse.json({ ok: true })
      }
      let closeOk = false
      let closeErr = ''
      try {
        closeOk = await closePosition(positionId, 'manual_telegram')
      } catch (err) {
        closeErr = err instanceof Error ? err.message : String(err)
      }
      if (closeOk) {
        await reply(chatId, `✅ Position \`${positionId}\` (${pos.symbol}) closed successfully.`)
      } else {
        const detail = closeErr ? `: ${closeErr}` : ' — check logs'
        await reply(chatId, `❌ Failed to close \`${positionId}\` (${pos.symbol})${detail}`)
      }
      return NextResponse.json({ ok: true })
    }

    // --------------------------------------------------------------- /rebalance
    if (command === '/rebalance') {
      const positionId = parts[1]
      if (!positionId) {
        await reply(chatId, '❌ Usage: `/rebalance <position_id>`')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, `⏳ Rebalancing position \`${positionId}\`...`)
      const supabase = createServerClient()
      const { data: pos, error } = await supabase
        .from('lp_positions')
        .select('*')
        .eq('id', positionId)
        .single()
      if (error || !pos) {
        await reply(chatId, `❌ Position \`${positionId}\` not found.`)
        return NextResponse.json({ ok: true })
      }
      if (pos.status === 'closed') {
        await reply(chatId, `ℹ️ Position \`${positionId}\` (${pos.symbol}) is already closed.`)
        return NextResponse.json({ ok: true })
      }
      const strategyId = pos.strategy_id ?? pos.metadata?.strategy_id
      const strategy = STRATEGIES.find((s) => s.id === strategyId)
      if (!strategy) {
        await reply(chatId, `❌ Strategy \`${strategyId}\` not found for position \`${positionId}\`.`)
        return NextResponse.json({ ok: true })
      }
      let closeOk = false
      let closeErr = ''
      try {
        closeOk = await closePosition(positionId, 'manual_rebalance')
      } catch (err) {
        closeErr = err instanceof Error ? err.message : String(err)
      }
      if (!closeOk) {
        const detail = closeErr ? `: ${closeErr}` : ' — check logs'
        await reply(chatId, `❌ Rebalance: failed to close \`${positionId}\` (${pos.symbol})${detail}`)
        return NextResponse.json({ ok: true })
      }
      // Reopen centered at current price using the same strategy
      let reopenId: string | null = null
      let reopenErr = ''
      try {
        const metrics: TokenMetrics = {
          address:       pos.mint,
          symbol:        pos.symbol,
          poolAddress:   pos.pool_address,
          priceUsd:      pos.current_price ?? pos.entry_price_sol ?? 0,
          dexId:         pos.metadata?.dexId ?? 'meteora',
          mcUsd:         0,
          volume24h:     0,
          liquidityUsd:  0,
          topHolderPct:  0,
          holderCount:   0,
          ageHours:      0,
          rugcheckScore: 0,
          feeTvl24hPct:  0, // scorer re-evaluates live pool against strategy.filters.minFeeTvl24hPct
        }
        reopenId = await openPosition(metrics, strategy)
      } catch (err) {
        reopenErr = err instanceof Error ? err.message : String(err)
      }
      if (reopenId) {
        await reply(chatId, [
          `✅ *Rebalance complete* for ${pos.symbol}`,
          `Old: \`${positionId}\` closed`,
          `New: \`${reopenId}\` opened centered at current price`,
        ].join('\n'))
      } else {
        const detail = reopenErr ? `: ${reopenErr}` : ' — check logs'
        await reply(chatId, `⚠️ Position \`${positionId}\` closed but reopen failed${detail}`)
      }
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /scan
    if (command === '/scan') {
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '⚠️ Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }
      const state = await getBotState()
      if (guardBot(state)) {
        await reply(chatId, '🛑 Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, '⏳ Running scanner...')
      await runScanOnly(chatId)
      return NextResponse.json({ ok: true })
    }

    // --------------------------------------------------------------- /monitor
    if (command === '/monitor') {
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '⚠️ Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }
      const state = await getBotState()
      if (guardBot(state)) {
        await reply(chatId, '🛑 Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, '⏳ Running monitor...')
      await runMonitorOnly(chatId)
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /tick
    if (command === '/tick') {
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '⚠️ Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }
      const state = await getBotState()
      if (guardBot(state)) {
        await reply(chatId, '🛑 Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, '⏳ Running scan + monitor...')
      await runTick(chatId)
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /stop
    if (command === '/stop') {
      await setBotState({ enabled: false })
      await reply(chatId, [
        `🛑 *Bot stopped.*`,
        `• New ticks will be ignored until you send /start`,
        `• Open positions will NOT be monitored while stopped`,
        `• Send /start to resume`,
      ].join('\n'))
    }

    else if (command === '/start') {
      await setBotState({ enabled: true })
      const state = await getBotState()
      await reply(chatId, [
        `✅ *Bot started.*`,
        `• Enabled: ✅`,
        `• Dry run: ${state.dry_run ? '🟡 ON (no real trades)' : '🟢 OFF (live trading)'}`,
        `Send /scan to scan for candidates, /monitor to check positions, or /tick for both.`,
      ].join('\n'))
    }

    else if (command === '/dry') {
      await setBotState({ dry_run: true })
      await reply(chatId, [
        `🟡 *Dry-run mode enabled.*`,
        `• Scanner and monitor will run normally`,
        `• No real on-chain transactions will be sent`,
        `• Candidates and positions are still written to Supabase`,
      ].join('\n'))
    }

    else if (command === '/live') {
      await setBotState({ dry_run: false })
      await reply(chatId, [
        `🟢 *Live trading enabled.*`,
        `⚠️ Real SOL transactions will be sent when a candidate scores above threshold.`,
        `• Make sure WALLET\_PRIVATE\_KEY is set correctly`,
        `• Make sure MIN\_SCORE\_TO\_OPEN is tuned to your risk tolerance`,
        `• Send /dry at any time to switch back to dry-run`,
      ].join('\n'))
    }

    else if (command === '/status') {
      const supabase = createServerClient()
      const [stateRes, openRes, lastTickRes, liveLpRes] = await Promise.allSettled([
        getBotState(),
        supabase.from('lp_positions').select('id', { count: 'exact', head: true }).in('status', ['active', 'out_of_range']),
        supabase.from('bot_logs').select('created_at').eq('event', 'bot_tick').order('created_at', { ascending: false }).limit(1).single(),
        fetchLiveDlmmPositions(),
      ])
      const state       = stateRes.status === 'fulfilled' ? stateRes.value : { enabled: false, dry_run: true }
      const openCount   = openRes.status === 'fulfilled' ? openRes.value.count : '?'
      const lastTick    = lastTickRes.status === 'fulfilled' ? lastTickRes.value.data?.created_at : null
      const liveLpCount = liveLpRes.status === 'fulfilled' ? liveLpRes.value.length : 0
      const lastTickStr = lastTick ? new Date(lastTick).toUTCString() : 'Never'
      await reply(chatId, [
        `📊 *Bot Status*`,
        `Enabled:        ${state.enabled  ? '✅ Running' : '🛑 Stopped'}`,
        `Mode:           ${state.dry_run  ? '🟡 Dry run' : '🟢 Live trading'}`,
        `Open positions: ${openCount} cached / ${liveLpCount} Meteora live`,
        `Last tick:      ${lastTickStr}`,
      ].join('\n'))
    }

    else if (command === '/help') {
      await reply(chatId, [
        `🤖 *Meteoracle Commands*`,
        ``,
        `*Run*`,
        `/scan    — scan for new candidates & open positions`,
        `/monitor — check open positions, trigger exits/rebalances`,
        `/tick    — run scan + monitor together`,
        ``,
        `*Positions*`,
        `/close <id>     — manually force-close a position`,
        `/rebalance <id> — close + reopen centered at current price`,
        ``,
        `*Control*`,
        `/stop    — pause all scanning & monitoring`,
        `/start   — resume the bot`,
        `/dry     — switch to dry-run (no real trades)`,
        `/live    — switch to live trading ⚠️`,
        ``,
        `*Info*`,
        `/status  — current state, positions, last tick`,
        `/help    — show this message`,
      ].join('\n'))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram webhook] error:', err)
    return NextResponse.json({ ok: true })
  }
}
