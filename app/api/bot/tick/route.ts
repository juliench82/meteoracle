import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { checkDammPositions } from '@/lib/pre-grad'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'

export const dynamic = 'force-dynamic'

/**
 * Main bot tick — called by Vercel Cron (and manually via Telegram /tick).
 * Order of checks:
 *  1. BOT_ENABLED env var — hard kill-switch, survives DB outages
 *  2. bot_state.enabled  — soft runtime toggle via /stop and /start
 *  3. monitorPositions   — DLMM exits (time-sensitive)
 *  4. checkDammPositions — DAMM v2 exits (time-sensitive)
 *  5. runScanner         — new candidates
 */
export async function POST() {
  if (process.env.BOT_ENABLED !== 'true') {
    return NextResponse.json({
      status: 'disabled',
      reason: 'BOT_ENABLED env var is not true',
    })
  }

  const state = await getBotState()
  if (!state.enabled) {
    return NextResponse.json({
      status: 'stopped',
      reason: 'bot_state.enabled=false — send /start in Telegram to resume',
      ts: new Date().toISOString(),
    })
  }

  const startedAt = Date.now()
  const supabase = createServerClient()

  try {
    const monitorResult = await monitorPositions()
    const dammResult = await checkDammPositions()
    const scanResult = await runScanner()

    const payload = {
      monitor: monitorResult,
      damm: dammResult,
      scanner: scanResult,
      durationMs: Date.now() - startedAt,
    }

    await supabase.from('bot_logs').insert({
      level: 'info',
      event: 'bot_tick',
      payload,
    })

    return NextResponse.json({ status: 'ok', ts: new Date().toISOString(), ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'bot_tick_failed',
      payload: { error: message, durationMs: Date.now() - startedAt },
    })

    return NextResponse.json({ status: 'error', error: message }, { status: 500 })
  }
}

export async function GET() {
  return POST()
}
