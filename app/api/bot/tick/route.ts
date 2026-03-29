import { NextResponse } from 'next/server'

// Cron endpoint — called every minute by Vercel Cron (vercel.json)
// TODO: wire scanner → scorer → executor → monitor in feature branches
export async function POST() {
  const botEnabled = process.env.BOT_ENABLED === 'true'

  if (!botEnabled) {
    return NextResponse.json({ status: 'disabled', message: 'Set BOT_ENABLED=true to activate' })
  }

  // TODO: await runBotTick()
  return NextResponse.json({ status: 'ok', ts: new Date().toISOString() })
}

// Allow GET for easy manual testing
export async function GET() {
  return POST()
}
