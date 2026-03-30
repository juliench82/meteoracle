import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { createServerClient } from '@/lib/supabase'
import axios from 'axios'

export const dynamic = 'force-dynamic'

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

async function reply(chatId: number | string, text: string) {
  if (!TELEGRAM_BOT_TOKEN) return
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'Markdown', disable_web_page_preview: true },
    { timeout: 5_000 }
  ).catch(() => {})
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const message = body?.message
    if (!message) return NextResponse.json({ ok: true })

    const chatId = message.chat?.id
    const text: string = message.text ?? ''
    const command = text.split(' ')[0].toLowerCase()

    // Security: only allow commands from the configured chat
    if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
      return NextResponse.json({ ok: true })
    }

    if (command === '/tick' || command === '/scan') {
      await reply(chatId, '⏳ Running scanner...')

      const botEnabled = process.env.BOT_ENABLED === 'true'
      if (!botEnabled) {
        await reply(chatId, '⚠️ Bot is disabled. Set `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }

      const startedAt = Date.now()
      const [monitorResult, scanResult] = await Promise.all([
        monitorPositions(),
        runScanner(),
      ])

      const supabase = createServerClient()
      await supabase.from('bot_logs').insert({
        level: 'info',
        event: 'bot_tick',
        payload: { monitor: monitorResult, scanner: scanResult, durationMs: Date.now() - startedAt, source: 'telegram' },
      })

      await reply(chatId, [
        `✅ *Tick complete* (${Date.now() - startedAt}ms)`,
        `📡 Scanned: ${scanResult.scanned} pairs`,
        `🎯 Candidates: ${scanResult.candidates}`,
        `📂 Opened: ${scanResult.opened} positions`,
        `👁 Monitored: ${monitorResult.checked} positions`,
        `🔒 Closed: ${monitorResult.closed}`,
      ].join('\n'))
    }

    else if (command === '/status') {
      const supabase = createServerClient()
      const [openRes, lastTickRes] = await Promise.allSettled([
        supabase.from('positions').select('id', { count: 'exact', head: true }).in('status', ['active', 'out_of_range']),
        supabase.from('bot_logs').select('created_at').eq('event', 'bot_tick').order('created_at', { ascending: false }).limit(1).single(),
      ])

      const openCount = openRes.status === 'fulfilled' ? openRes.value.count : '?'
      const lastTick = lastTickRes.status === 'fulfilled' ? lastTickRes.value.data?.created_at : null
      const lastTickStr = lastTick ? new Date(lastTick).toUTCString() : 'Never'

      await reply(chatId, [
        `📊 *Bot Status*`,
        `Enabled: ${process.env.BOT_ENABLED === 'true' ? '✅' : '❌'}`,
        `Dry run: ${process.env.BOT_DRY_RUN === 'true' ? '✅' : '❌'}`,
        `Open positions: ${openCount}`,
        `Last tick: ${lastTickStr}`,
      ].join('\n'))
    }

    else if (command === '/help') {
      await reply(chatId, [
        `🤖 *Meteoracle Bot Commands*`,
        `/tick — run scanner + monitor now`,
        `/status — show current bot status`,
        `/help — show this message`,
      ].join('\n'))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram webhook] error:', err)
    return NextResponse.json({ ok: true }) // always 200 to Telegram
  }
}
