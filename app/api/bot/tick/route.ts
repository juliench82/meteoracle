import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { createServerClient } from '@/lib/supabase'
import { getBotState } from '@/lib/botState'

export const dynamic = 'force-dynamic'

/**
 * Main bot tick — called by Vercel Cron (and manually via Telegram /tick).
 * Order of checks:
 *  1. BOT_ENABLED env var — hard kill-switch, survives DB outages
 *  2. bot_state.enabled  — soft runtime toggle via /stop and /start
 *  3. monitor first (time-sensitive exits), then scanner
 */
export async function POST() {
  // 1. Hard kill-switch — env var must be 'true'
  if (process.env.BOT_ENABLED !== 'true') {
    return NextResponse.json({
      status: 'disabled',
      reason: 'BOT_ENABLED env var is not true',
    })
  }

  // 2. Runtime toggle — reads from Supabase bot_state table
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
    // 3. Monitor open positions first — exits are time-sensitive
    const monitorResult = await monitorPositions()

    // 4. Scan for new candidates
    const scanResult = await runScanner()

    const payload = {
      monitor: monitorResult,
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
