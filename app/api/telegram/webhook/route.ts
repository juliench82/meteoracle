import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { createServerClient } from '@/lib/supabase'
import { getBotState, setBotState } from '@/lib/botState'
import axios from 'axios'

export const dynamic = 'force-dynamic'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID

async function reply(chatId: number | string, text: string) {
  if (!TELEGRAM_BOT_TOKEN) return
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 5_000 },
  ).catch(() => {})
}

// ---------------------------------------------------------------------------
// runTick — the actual monitor + scanner work, called async after we have
// already returned 200 OK to Telegram.  This prevents Telegram from retrying
// the webhook when the scan takes longer than ~30 s.
// ---------------------------------------------------------------------------
async function runTick(chatId: number | string) {
  const startedAt = Date.now()
  try {
    const [monitorResult, scanResult] = await Promise.all([
      monitorPositions(),
      runScanner(),
    ])
    const durationMs = Date.now() - startedAt

    const supabase = createServerClient()
    await supabase.from('bot_logs').insert({
      level:   'info',
      event:   'bot_tick',
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
    await reply(chatId, `❌ Tick failed: ${msg}`)
  }
}

export async function POST(req: Request) {
  try {
    const body    = await req.json()
    const message = body?.message
    if (!message) return NextResponse.json({ ok: true })

    const chatId  = message.chat?.id
    const text: string = message.text ?? ''
    const command = text.split(' ')[0].toLowerCase()

    // Security: only respond to the configured owner chat
    if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------
    // /tick  — run one full monitor + scanner cycle (fire-and-forget)
    // ------------------------------------------------------------------
    if (command === '/tick' || command === '/scan') {
      // Gate checks FIRST
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '⚠️ Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }

      const state = await getBotState()
      if (!state.enabled) {
        await reply(chatId, '🛑 Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }

      // Send the "running" reply immediately so the user gets feedback
      await reply(chatId, '⏳ Running scanner...')

      // Return 200 OK to Telegram NOW — before the scan starts.
      // This prevents Telegram from retrying the webhook after 30 s.
      // The scan continues in the background via waitUntil (Vercel Edge)
      // or a detached Promise (Node runtime).
      const res = NextResponse.json({ ok: true })

      const tickPromise = runTick(chatId)

      // Use waitUntil if available (Vercel Edge / Cloudflare Workers)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (globalThis as any)[Symbol.for('vercel.wait_until_ctx')]
      if (ctx?.waitUntil) {
        ctx.waitUntil(tickPromise)
      } else {
        // Node.js runtime: detach the promise (Vercel will keep the
        // function warm long enough to finish on Pro/hobby with 60s limit)
        tickPromise.catch((err) => console.error('[tick] background error:', err))
      }

      return res
    }

    // ------------------------------------------------------------------
    // /stop  — pause the bot
    // ------------------------------------------------------------------
    else if (command === '/stop') {
      await setBotState({ enabled: false })
      await reply(chatId, [
        `🛑 *Bot stopped.*`,
        `• New ticks will be ignored until you send /start`,
        `• Open positions will NOT be monitored while stopped`,
        `• Send /start to resume`,
      ].join('\n'))
    }

    // ------------------------------------------------------------------
    // /start — resume the bot
    // ------------------------------------------------------------------
    else if (command === '/start') {
      await setBotState({ enabled: true })
      const state = await getBotState()
      await reply(chatId, [
        `✅ *Bot started.*`,
        `• Enabled: ✅`,
        `• Dry run: ${state.dry_run ? '🟡 ON (no real trades)' : '🟢 OFF (live trading)'}`,
        `Send /tick to run a scan immediately.`,
      ].join('\n'))
    }

    // ------------------------------------------------------------------
    // /dry  — switch to dry-run
    // ------------------------------------------------------------------
    else if (command === '/dry') {
      await setBotState({ dry_run: true })
      await reply(chatId, [
        `🟡 *Dry-run mode enabled.*`,
        `• Scanner and monitor will run normally`,
        `• No real on-chain transactions will be sent`,
        `• Candidates and positions are still written to Supabase`,
      ].join('\n'))
    }

    // ------------------------------------------------------------------
    // /live — switch to live trading
    // ------------------------------------------------------------------
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

    // ------------------------------------------------------------------
    // /status — live state from DB
    // ------------------------------------------------------------------
    else if (command === '/status') {
      const supabase = createServerClient()
      const [stateRes, openRes, lastTickRes] = await Promise.allSettled([
        getBotState(),
        supabase
          .from('positions')
          .select('id', { count: 'exact', head: true })
          .in('status', ['active', 'out_of_range']),
        supabase
          .from('bot_logs')
          .select('created_at')
          .eq('event', 'bot_tick')
          .order('created_at', { ascending: false })
          .limit(1)
          .single(),
      ])

      const state       = stateRes.status === 'fulfilled' ? stateRes.value : { enabled: false, dry_run: true }
      const openCount   = openRes.status === 'fulfilled' ? openRes.value.count : '?'
      const lastTick    = lastTickRes.status === 'fulfilled' ? lastTickRes.value.data?.created_at : null
      const lastTickStr = lastTick ? new Date(lastTick).toUTCString() : 'Never'

      await reply(chatId, [
        `📊 *Bot Status*`,
        `Enabled:        ${state.enabled  ? '✅ Running' : '🛑 Stopped'}`,
        `Mode:           ${state.dry_run  ? '🟡 Dry run' : '🟢 Live trading'}`,
        `Open positions: ${openCount}`,
        `Last tick:      ${lastTickStr}`,
      ].join('\n'))
    }

    // ------------------------------------------------------------------
    // /help
    // ------------------------------------------------------------------
    else if (command === '/help') {
      await reply(chatId, [
        `🤖 *Meteoracle Commands*`,
        ``,
        `*Control*`,
        `/stop  — pause all scanning & monitoring`,
        `/start — resume the bot`,
        `/dry   — switch to dry-run (no real trades)`,
        `/live  — switch to live trading ⚠️`,
        ``,
        `*Info*`,
        `/tick   — run one scan + monitor cycle now`,
        `/status — current state, positions, last tick`,
        `/help   — show this message`,
      ].join('\n'))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram webhook] error:', err)
    return NextResponse.json({ ok: true })
  }
}
