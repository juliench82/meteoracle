import { NextResponse } from 'next/server'
import { runScanner } from '@/bot/scanner'
import { createServerClient } from '@/lib/supabase'

// Cron endpoint — called every minute by Vercel Cron (vercel.json)
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
    const result = await runScanner()

    // Log the tick to Supabase
    await supabase.from('bot_logs').insert({
      level: 'info',
      event: 'scanner_tick',
      payload: {
        ...result,
        durationMs: Date.now() - startedAt,
      },
    })

    return NextResponse.json({
      status: 'ok',
      ts: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ...result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    await supabase.from('bot_logs').insert({
      level: 'error',
      event: 'scanner_tick_failed',
      payload: { error: message, durationMs: Date.now() - startedAt },
    })

    return NextResponse.json(
      { status: 'error', error: message },
      { status: 500 }
    )
  }
}

export async function GET() {
  return POST()
}
