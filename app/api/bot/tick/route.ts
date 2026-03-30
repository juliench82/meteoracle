import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { createServerClient } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

/**
 * Main bot tick — called every minute by Vercel Cron.
 * Order: monitor first (time-sensitive exits), then scan for new candidates.
 */
export async function POST() {
  const botEnabled = process.env.BOT_ENABLED === 'true'

  if (!botEnabled) {
    return NextResponse.json({
      status: 'disabled',
      message: 'Set BOT_ENABLED=true to activate',
    })
  }

  const startedAt = Date.now()
  const supabase = createServerClient()

  try {
    // 1. Monitor open positions first — exits are time-sensitive
    const monitorResult = await monitorPositions()

    // 2. Scan for new candidates
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
