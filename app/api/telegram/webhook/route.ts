import { NextResponse } from 'next/server'
import { runScanner, type ScannerResult } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { addLiquidityToPosition, closePosition } from '@/bot/executor'
import { closeDammPosition } from '@/bot/damm-executor'
import { rebalanceDlmmPosition } from '@/bot/rebalance'
import { createServerClient } from '@/lib/supabase'
import { getBotState, setBotState, acquireRunLock, releaseRunLock } from '@/lib/botState'
import { fetchLiveMeteoraSnapshot } from '@/lib/meteora-live'
import { fetchWalletLiveBalances } from '@/lib/wallet-live'
import { syncAllMeteoraPositions } from '@/lib/position-sync'
import { isTelegramCommandAllowed } from '@/lib/telegram-auth'
import axios from 'axios'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
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

function formatReason(reason?: string): string {
  return reason ? reason.replace(/_/g, ' ') : ''
}

function sanitizeLiveError(message?: string | null): string | null {
  if (!message) return null
  return message
    .replace(/api-key=[^"'\s&]+/gi, 'api-key=redacted')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function formatScanResult(scanResult: ScannerResult): string[] {
  const lines = [
    `\u{1F4E1} Scanned: ${scanResult.scanned} pairs`,
    `\u{1F50E} Deep checked: ${scanResult.deepChecked}/${scanResult.survivors}`,
    `\u{1F3AF} Candidates: ${scanResult.candidates}`,
    `\u{1F4C2} Opened: ${scanResult.opened} positions`,
  ]
  if (scanResult.openSkipped > 0) {
    lines.push(`\u23F8 Opening skipped: ${scanResult.openSkipped}`)
  }
  if (scanResult.openBlockedReason) {
    lines.push(`\u{1F6A7} Opening blocked: ${formatReason(scanResult.openBlockedReason)}`)
  }
  return lines
}

async function runTick(chatId: number | string, supabase: ReturnType<typeof createServerClient>) {
  const startedAt = Date.now()
  try {
    const [monitorResult, scanResult] = await Promise.all([
      monitorPositions(),
      runScanner(),
    ])
    const durationMs = Date.now() - startedAt
    logToDB(supabase, {
      level: 'info', event: 'bot_tick',
      payload: { monitor: monitorResult, scanner: scanResult, durationMs, source: 'telegram' },
    })
    await reply(chatId, [
      `\u2705 *Tick complete* (${durationMs}ms)`,
      ...formatScanResult(scanResult),
      `\u{1F441} Monitored: ${monitorResult.checked} positions`,
      `\u{1F512} Closed: ${monitorResult.closed}`,
    ].join('\n'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[tick] error:', msg)
    await reply(chatId, `\u274C Tick failed: ${msg}`)
  }
}

async function runScanOnly(chatId: number | string, supabase: ReturnType<typeof createServerClient>) {
  const startedAt = Date.now()
  try {
    const scanResult = await runScanner()
    const durationMs = Date.now() - startedAt
    logToDB(supabase, {
      level: 'info', event: 'bot_scan',
      payload: { scanner: scanResult, durationMs, source: 'telegram' },
    })
    await reply(chatId, [
      `\u{1F4E1} *Scan complete* (${durationMs}ms)`,
      ...formatScanResult(scanResult),
    ].join('\n'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scan] error:', msg)
    await reply(chatId, `\u274C Scan failed: ${msg}`)
  }
}

async function runMonitorOnly(chatId: number | string, supabase: ReturnType<typeof createServerClient>) {
  const startedAt = Date.now()
  try {
    const monitorResult = await monitorPositions()
    const durationMs = Date.now() - startedAt
    logToDB(supabase, {
      level: 'info', event: 'bot_monitor',
      payload: { monitor: monitorResult, durationMs, source: 'telegram' },
    })
    await reply(chatId, [
      `\u{1F441} *Monitor complete* (${durationMs}ms)`,
      `Checked: ${monitorResult.checked} positions`,
      `\u{1F512} Closed: ${monitorResult.closed}`,
      `\u{1F504} Rebalanced: ${monitorResult.rebalanced}`,
      `\u{1F4B0} Fee claims logged: ${monitorResult.claimed}`,
    ].join('\n'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[monitor] error:', msg)
    await reply(chatId, `\u274C Monitor failed: ${msg}`)
  }
}

function guardBot(state: { enabled: boolean }) {
  return !state.enabled
}

function isDammLp(pos: { strategy_id?: string | null; position_type?: string | null }): boolean {
  return (
    pos.strategy_id === 'damm-edge' ||
    pos.strategy_id === 'damm-live' ||
    pos.strategy_id === 'damm-migration' ||
    pos.position_type === 'damm-edge' ||
    pos.position_type === 'damm-migration'
  )
}

async function closeLpPositionByKind(
  pos: { id: string; strategy_id?: string | null; position_type?: string | null },
  reason: string,
): Promise<boolean> {
  if (isDammLp(pos)) {
    const result = await closeDammPosition(pos.id, reason)
    return result.success
  }
  return closePosition(pos.id, reason)
}

function parseSolAmount(value: string | undefined): number | null {
  if (!value) return null
  const amount = Number(value.replace(',', '.'))
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

async function resolveAddTarget(
  parts: string[],
  supabase: ReturnType<typeof createServerClient>,
): Promise<{
  positionId: string | null
  solAmount: number | null
  error?: string
}> {
  await syncAllMeteoraPositions().catch(err =>
    console.warn('[telegram webhook] /add pre-sync failed:', err)
  )

  const { data: positions, error } = await supabase
    .from('lp_positions')
    .select('id, symbol, status, strategy_id, position_type')
    .in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry'])

  if (error) {
    return { positionId: null, solAmount: null, error: `Could not load positions: ${error.message}` }
  }

  const dlmmPositions = (positions ?? []).filter(position => !isDammLp(position))
  if (parts.length === 2) {
    const solAmount = parseSolAmount(parts[1])
    if (solAmount === null) {
      return { positionId: null, solAmount: null, error: 'Usage: `/add <position_id> <SOL>` or `/add <SOL>` when exactly one DLMM position is open.' }
    }
    if (dlmmPositions.length !== 1) {
      return {
        positionId: null,
        solAmount,
        error: `Found ${dlmmPositions.length} open DLMM positions. Use \`/add <position_id> ${solAmount}\`.`,
      }
    }
    return { positionId: dlmmPositions[0].id, solAmount }
  }

  const positionArg = parts[1]
  const solAmount = parseSolAmount(parts[2])
  if (!positionArg || solAmount === null) {
    return { positionId: null, solAmount: null, error: 'Usage: `/add <position_id> <SOL>`' }
  }

  const matches = dlmmPositions.filter(position => position.id === positionArg || position.id.startsWith(positionArg))
  if (matches.length === 0) {
    return { positionId: null, solAmount, error: `No open DLMM position matches \`${positionArg}\`.` }
  }
  if (matches.length > 1) {
    return { positionId: null, solAmount, error: `\`${positionArg}\` matches multiple positions. Use the full position id.` }
  }

  return { positionId: matches[0].id, solAmount }
}

export async function POST(req: Request) {
  // Single Supabase client for the lifetime of this request
  const supabase = createServerClient()

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
    const fromId  = message.from?.id
    const text: string = message.text ?? ''
    const parts   = text.trim().split(/\s+/)
    const command = parts[0].toLowerCase()

    if (!isTelegramCommandAllowed(fromId, chatId)) {
      logToDB(supabase, {
        level: 'warn',
        event: 'unauthorized_command',
        payload: { fromId, chatId, command },
      })
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /close
    if (command === '/close') {
      const positionId = parts[1]
      if (!positionId) {
        await reply(chatId, '\u274C Usage: `/close <position_id>`')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, `\u23F3 Closing position \`${positionId}\`...`)
      const { data: pos, error } = await supabase
        .from('lp_positions')
        .select('id, symbol, status, strategy_id, position_type')
        .eq('id', positionId)
        .single()
      if (error || !pos) {
        await reply(chatId, `\u274C Position \`${positionId}\` not found.`)
        return NextResponse.json({ ok: true })
      }
      if (pos.status === 'closed') {
        await reply(chatId, `\u2139\uFE0F Position \`${positionId}\` (${pos.symbol}) is already closed.`)
        return NextResponse.json({ ok: true })
      }
      let closeOk = false
      let closeErr = ''
      try {
        closeOk = await closeLpPositionByKind(pos, 'manual_telegram')
      } catch (err) {
        closeErr = err instanceof Error ? err.message : String(err)
      }
      if (closeOk) {
        await reply(chatId, `\u2705 Position \`${positionId}\` (${pos.symbol}) closed successfully.`)
      } else {
        const detail = closeErr ? `: ${closeErr}` : ' \u2014 check logs'
        await reply(chatId, `\u274C Failed to close \`${positionId}\` (${pos.symbol})${detail}`)
      }
      return NextResponse.json({ ok: true })
    }

    // -------------------------------------------------------------------- /add
    if (command === '/add') {
      const { positionId, solAmount, error } = await resolveAddTarget(parts, supabase)
      if (error || !positionId || solAmount === null) {
        await reply(chatId, `\u274C ${error ?? 'Usage: `/add <position_id> <SOL>`'}`)
        return NextResponse.json({ ok: true })
      }

      await reply(chatId, `\u23F3 Adding ${solAmount} SOL to position \`${positionId}\`...`)
      const result = await addLiquidityToPosition(positionId, solAmount)
      if (result.success && result.dryRun) {
        await reply(chatId, `\u{1F7E1} Dry-run: would add ${result.solAdded} SOL to ${result.symbol}. No transaction sent.`)
      } else if (result.success) {
        await reply(chatId, [
          `\u2705 Added ${result.solAdded} SOL to ${result.symbol}.`,
          `Position: \`${positionId}\``,
          `Tx: \`${result.txSignature}\``,
        ].join('\n'))
      } else {
        await reply(chatId, `\u274C Add liquidity failed for ${result.symbol}: ${result.error ?? 'unknown error'}`)
      }
      return NextResponse.json({ ok: true })
    }

    // --------------------------------------------------------------- /rebalance
    if (command === '/rebalance') {
      const positionId = parts[1]
      if (!positionId) {
        await reply(chatId, '\u274C Usage: `/rebalance <position_id>`')
        return NextResponse.json({ ok: true })
      }
      await reply(chatId, `\u23F3 Rebalancing position \`${positionId}\`...`)
      const result = await rebalanceDlmmPosition(positionId, {
        reason: 'manual_rebalance',
        source: 'telegram_webhook',
      })
      if (result.reopened && result.newPositionId) {
        await reply(chatId, [
          `\u2705 *Rebalance complete* for ${result.symbol}`,
          `Old: \`${result.oldPositionId}\` closed`,
          `New: \`${result.newPositionId}\` opened centered at current price`,
        ].join('\n'))
      } else if (result.closed) {
        await reply(chatId, `\u26A0\uFE0F Position \`${result.oldPositionId}\` closed but reopen failed: ${result.error ?? 'unknown error'}`)
      } else {
        await reply(chatId, `\u274C Rebalance skipped for \`${positionId}\`: ${result.error ?? 'unknown error'}`)
      }
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /scan
    if (command === '/scan') {
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '\u26A0\uFE0F Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }
      const state = await getBotState()
      if (guardBot(state)) {
        await reply(chatId, '\u{1F6D1} Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }
      const locked = await acquireRunLock()
      if (!locked) {
        await reply(chatId, '\u23F3 A scan or tick is already running. Try again in a moment.')
        return NextResponse.json({ ok: true })
      }
      try {
        await reply(chatId, '\u23F3 Running scanner...')
        await runScanOnly(chatId, supabase)
      } finally {
        await releaseRunLock()
      }
      return NextResponse.json({ ok: true })
    }

    // --------------------------------------------------------------- /monitor
    if (command === '/monitor') {
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '\u26A0\uFE0F Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }
      const state = await getBotState()
      if (guardBot(state)) {
        await reply(chatId, '\u{1F6D1} Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }
      const locked = await acquireRunLock()
      if (!locked) {
        await reply(chatId, '\u23F3 A monitor or tick is already running. Try again in a moment.')
        return NextResponse.json({ ok: true })
      }
      try {
        await reply(chatId, '\u23F3 Running monitor...')
        await runMonitorOnly(chatId, supabase)
      } finally {
        await releaseRunLock()
      }
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /tick
    if (command === '/tick') {
      if (process.env.BOT_ENABLED !== 'true') {
        await reply(chatId, '\u26A0\uFE0F Bot is disabled.\nSet `BOT_ENABLED=true` in Vercel env vars.')
        return NextResponse.json({ ok: true })
      }
      const state = await getBotState()
      if (guardBot(state)) {
        await reply(chatId, '\u{1F6D1} Bot is stopped.\nSend /start to resume.')
        return NextResponse.json({ ok: true })
      }
      const locked = await acquireRunLock()
      if (!locked) {
        await reply(chatId, '\u23F3 A tick is already running. Try again in a moment.')
        return NextResponse.json({ ok: true })
      }
      try {
        await reply(chatId, '\u23F3 Running scan + monitor...')
        await runTick(chatId, supabase)
      } finally {
        await releaseRunLock()
      }
      return NextResponse.json({ ok: true })
    }

    // ------------------------------------------------------------------ /stop
    if (command === '/stop') {
      await setBotState({ enabled: false })
      await reply(chatId, [
        `\u{1F6D1} *Bot stopped.*`,
        `\u2022 New ticks will be ignored until you send /start`,
        `\u2022 Open positions will NOT be monitored while stopped`,
        `\u2022 Send /start to resume`,
      ].join('\n'))
    }

    else if (command === '/start') {
      await setBotState({ enabled: true })
      const state = await getBotState()
      await reply(chatId, [
        `\u2705 *Bot started.*`,
        `\u2022 Enabled: \u2705`,
        `\u2022 Dry run: ${state.dry_run ? '\u{1F7E1} ON (no real trades)' : '\u{1F7E2} OFF (live trading)'}`,
        `Send /scan to scan for candidates, /monitor to check positions, or /tick for both.`,
      ].join('\n'))
    }

    else if (command === '/dry') {
      await setBotState({ dry_run: true })
      await reply(chatId, [
        `\u{1F7E1} *Dry-run mode enabled.*`,
        `\u2022 Scanner and monitor will run normally`,
        `\u2022 No real on-chain transactions will be sent`,
        `\u2022 Candidates and positions are still written to Supabase`,
      ].join('\n'))
    }

    else if (command === '/live') {
      await setBotState({ dry_run: false })
      await reply(chatId, [
        `\u{1F7E2} *Live trading enabled.*`,
        `\u26A0\uFE0F Real SOL transactions will be sent when a candidate scores above threshold.`,
        `\u2022 Make sure WALLET\_PRIVATE\_KEY is set correctly`,
        `\u2022 Make sure MIN\_SCORE\_TO\_OPEN is tuned to your risk tolerance`,
        `\u2022 Send /dry at any time to switch back to dry-run`,
      ].join('\n'))
    }

    else if (command === '/status') {
      const [stateRes, openRes, lastTickRes, liveLpRes, walletRes] = await Promise.allSettled([
        getBotState(),
        supabase.from('lp_positions').select('id', { count: 'exact', head: true }).in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry']),
        supabase.from('bot_logs').select('created_at').eq('event', 'bot_tick').order('created_at', { ascending: false }).limit(1).single(),
        fetchLiveMeteoraSnapshot(),
        fetchWalletLiveBalances(),
      ])
      const state       = stateRes.status === 'fulfilled' ? stateRes.value : { enabled: false, dry_run: true, is_running: false }
      const openCount   = openRes.status === 'fulfilled' ? openRes.value.count : '?'
      const lastTick    = lastTickRes.status === 'fulfilled' ? lastTickRes.value.data?.created_at : null
      const liveSnapshot = liveLpRes.status === 'fulfilled' ? liveLpRes.value : null
      const liveLpCount = liveSnapshot?.positions.length ?? 0
      const liveDlmmCount = liveSnapshot?.positions.filter(p => p.position_type === 'dlmm').length ?? 0
      const liveDammCount = liveSnapshot?.positions.filter(p => p.position_type === 'damm-edge').length ?? 0
      const liveWarning = liveSnapshot && (!liveSnapshot.dlmmOk || !liveSnapshot.dammOk)
        ? [
          `Meteora fetch incomplete: DLMM ${liveSnapshot.dlmmOk ? 'ok' : 'failed'} / DAMM ${liveSnapshot.dammOk ? 'ok' : 'failed'}`,
          ...[
            liveSnapshot.dlmmOk ? null : sanitizeLiveError(liveSnapshot.dlmmError),
            liveSnapshot.dammOk ? null : sanitizeLiveError(liveSnapshot.dammError),
          ].filter(Boolean).map(reason => `Reason: ${reason}`),
        ].join('\n')
        : null
      const walletSol = walletRes.status === 'fulfilled' ? walletRes.value.sol : null
      const lastTickStr = lastTick ? new Date(lastTick).toUTCString() : 'Never'
      await reply(chatId, [
        `\u{1F4CA} *Bot Status*`,
        `Enabled:        ${'enabled' in state && state.enabled ? '\u2705 Running' : '\u{1F6D1} Stopped'}`,
        `Mode:           ${'dry_run' in state && state.dry_run ? '\u{1F7E1} Dry run' : '\u{1F7E2} Live trading'}`,
        `Running:        ${'is_running' in state && state.is_running ? '\u23F3 Yes' : '\u2705 Idle'}`,
        `Wallet:         ${walletSol != null ? walletSol.toFixed(4) : 'n/a'} SOL`,
        `Open positions: ${liveLpCount} Meteora live / ${openCount} cached`,
        `Meteora live:  ${liveDlmmCount} DLMM / ${liveDammCount} DAMM`,
        ...(liveWarning ? [`\u26A0\uFE0F ${liveWarning}`] : []),
        `Last tick:      ${lastTickStr}`,
      ].join('\n'))
    }

    else if (command === '/help') {
      await reply(chatId, [
        `\u{1F916} *Meteoracle Commands*`,
        ``,
        `*Run*`,
        `/scan    \u2014 scan for new candidates & open positions`,
        `/monitor \u2014 check open positions, trigger exits/rebalances`,
        `/tick    \u2014 run scan + monitor together`,
        ``,
        `*Positions*`,
        `/close <id>     \u2014 manually force-close a position`,
        `/add <id> <SOL> \u2014 add SOL liquidity to a DLMM position`,
        `/rebalance <id> \u2014 close + reopen centered at current price`,
        ``,
        `*Control*`,
        `/stop    \u2014 pause all scanning & monitoring`,
        `/start   \u2014 resume the bot`,
        `/dry     \u2014 switch to dry-run (no real trades)`,
        `/live    \u2014 switch to live trading \u26A0\uFE0F`,
        ``,
        `*Info*`,
        `/status  \u2014 current state, positions, last tick`,
        `/help    \u2014 show this message`,
      ].join('\n'))
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[telegram webhook] error:', err)
    return NextResponse.json({ ok: true })
  }
}
