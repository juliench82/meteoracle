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
 *  3. monitorPositions   — DLMM + DAMM exits (time-sensitive)
 *  4. runScanner         — new candidates
 */
function getTickSecret(): string | null {
  return process.env.BOT_SECRET ?? process.env.BOT_TICK_SECRET ?? process.env.CRON_SECRET ?? null
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  const match = header?.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function authorizeTick(request: Request): NextResponse | null {
  const expected = getTickSecret()
  if (!expected) {
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  const provided = getBearerToken(request) ?? request.headers.get('x-bot-secret')
  if (provided !== expected) {
    return NextResponse.json({ status: 'unauthorized' }, { status: 401 })
  }

  return null
}

export async function POST(request: Request) {
  const authError = authorizeTick(request)
  if (authError) return authError

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

export async function GET(request: Request) {
  return POST(request)
}
