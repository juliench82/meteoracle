/**
 * telegram-bot.ts
 *
 * Standalone Telegram command bot using long-polling (getUpdates).
 * No webhook, no HTTPS needed — runs as a PM2 process on the VPS.
 *
 * Commands:
 *   /stop           — EMERGENCY: close all LP positions + pm2 stop workers
 *   /restart        — resume: setBotState enabled + pm2 restart workers
 *   /dry            — switch to dry-run mode
 *   /live           — switch to live trading
 *   /close <id>     — force-close an LP position by ID
 *   /add <id> <sol> — add SOL liquidity to an existing DLMM position
 *   /rebalance <id> — close + reopen a DLMM position centered at current price
 *   /positions      — list all open LP positions
 *   /status         — snapshot: state, open positions, wallet SOL
 *   /tick           — manually trigger scanner + monitor in parallel
 *   /orphans        — manually run orphan detector on demand
 *   /candidates     — list top candidates from last 24h sorted by score
 *   /help           — command list
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { exec } from 'child_process'
import { promisify } from 'util'
import { createServerClient } from '@/lib/supabase'
import { getBotState, setBotState } from '@/lib/botState'
import { addLiquidityToPosition, closePosition } from '@/bot/executor'
import { closeDammPosition } from '@/bot/damm-executor'
import { rebalanceDlmmPosition } from '@/bot/rebalance'
import { runScanner, type ScannerResult } from '@/bot/scanner'
import { monitorPositions } from '@/bot/monitor'
import { detectAllOrphanedPositions } from '@/bot/orphan-detector'
import { fetchLiveMeteoraSnapshot, mergeDbAndLiveLpPositions, type MeteoraLiveSourceStatus, type LiveMeteoraPosition } from '@/lib/meteora-live'
import { syncAllMeteoraPositions } from '@/lib/position-sync'
import { fetchWalletLiveBalances } from '@/lib/wallet-live'
import { getTelegramAllowedUsers, isTelegramCommandAllowed } from '@/lib/telegram-auth'

const execAsync = promisify(exec)
const PM2 = '/usr/local/bin/pm2'

const WORKER_PROCESSES = [
  'lp-scanner',
  'lp-monitor-dlmm',
  'dashboard',
]

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? ''
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? ''
const ALLOWED_USER_IDS = getTelegramAllowedUsers()
const POLL_MS = 2_000
const TICK_TIMEOUT_MS = 55_000
const API = `https://api.telegram.org/bot${BOT_TOKEN}`

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[telegram-bot] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — exiting')
  process.exit(1)
}

if (ALLOWED_USER_IDS.size === 0) {
  console.error('[telegram-bot] TELEGRAM_ALLOWED_USERS or TELEGRAM_CHAT_ID must include at least one authorized user id — exiting')
  process.exit(1)
}

let lastUpdateId = 0

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

function fmtUsd(value: unknown): string {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : 'n/a'
}

function fmtPrice(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 'n/a'
  return n >= 1 ? n.toFixed(4) : n.toPrecision(6)
}

function formatMinutesAgo(iso: string | null | undefined): string {
  if (!iso) return 'n/a'
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts) || ts <= 0) return 'n/a'
  const minutes = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  return `${minutes} min ago`
}

function isLiveConfirmedPosition(pos: { _source?: string | null }): boolean {
  return Boolean(pos._source?.includes('meteora'))
}

function parseSolAmount(value: string | undefined): number | null {
  if (!value) return null
  const normalized = value.replace(',', '.')
  const amount = Number(normalized)
  return Number.isFinite(amount) && amount > 0 ? amount : null
}

function sanitizeLiveError(message?: string | null): string | null {
  if (!message) return null
  return message
    .replace(/api-key=[^"'\s&]+/gi, 'api-key=redacted')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function liveSourceWarning(source: MeteoraLiveSourceStatus, errors?: { dlmm?: string | null; damm?: string | null }): string | null {
  if (source.dlmmOk && source.dammOk) return null
  const details = [
    source.dlmmOk ? null : sanitizeLiveError(errors?.dlmm),
    source.dammOk ? null : sanitizeLiveError(errors?.damm),
  ].filter(Boolean)
  return [
    `⚠️ Meteora live fetch incomplete: DLMM ${source.dlmmOk ? 'ok' : 'failed'} / DAMM ${source.dammOk ? 'ok' : 'failed'}`,
    ...(details.length ? [`Reason: ${details.join(' | ')}`] : []),
  ].join('\n')
}

async function resolveAddTarget(args: string[]): Promise<{
  positionId: string | null
  solAmount: number | null
  error?: string
}> {
  await syncAllMeteoraPositions().catch(err =>
    console.warn('[telegram-bot] /add pre-sync failed:', err)
  )

  const supabase = createServerClient()
  const { data: positions, error } = await supabase
    .from('lp_positions')
    .select('id, symbol, status, strategy_id, position_type')
    .in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry'])

  if (error) {
    return { positionId: null, solAmount: null, error: `Could not load positions: ${error.message}` }
  }

  const dlmmPositions = (positions ?? []).filter(position => !isDammLp(position))

  if (args.length === 1) {
    const solAmount = parseSolAmount(args[0])
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

  const positionArg = args[0]
  const solAmount = parseSolAmount(args[1])
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

async function reply(text: string): Promise<void> {
  try {
    await axios.post(`${API}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }, { timeout: 5_000 })
  } catch (err) {
    console.warn('[telegram-bot] reply failed:', err instanceof Error ? err.message : err)
  }
}

async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
  try {
    const res = await axios.get(`${API}/getUpdates`, {
      params: { offset: offset ?? lastUpdateId + 1, timeout: 10, limit: 100 },
      timeout: 15_000,
    })
    return res.data?.result ?? []
  } catch {
    return []
  }
}

interface TelegramUpdate {
  update_id: number
  message?: { chat: { id: number }; from?: { id: number }; text?: string }
}

async function drainPendingUpdates(): Promise<void> {
  console.log('[telegram-bot] draining stale updates...')
  const updates = await getUpdates()
  if (updates.length > 0) {
    lastUpdateId = updates[updates.length - 1].update_id
    await getUpdates(lastUpdateId + 1)
    console.log(`[telegram-bot] drained ${updates.length} stale update(s), resuming from id=${lastUpdateId}`)
  } else {
    console.log('[telegram-bot] no stale updates')
  }
}

async function pm2StopWorkers(): Promise<void> {
  const names = WORKER_PROCESSES.join(' ')
  await execAsync(`${PM2} stop ${names} --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 stop failed:', err.message)
  )
}

async function pm2RestartWorkers(): Promise<void> {
  const names = WORKER_PROCESSES.join(' ')
  await execAsync(`${PM2} restart ${names} --silent`).catch(err =>
    console.warn('[telegram-bot] pm2 restart failed:', err.message)
  )
}

function withTickTimeout(fn: () => Promise<string>, name: string): Promise<string> {
  return Promise.race([
    fn(),
    new Promise<string>(resolve =>
      setTimeout(() => resolve(`⏱️ ${name}: timeout (${TICK_TIMEOUT_MS / 1000}s)`), TICK_TIMEOUT_MS)
    ),
  ])
}

function formatReason(reason?: string): string {
  return reason ? reason.replace(/_/g, ' ') : ''
}

function formatScannerSummary(result: ScannerResult): string {
  const parts = [
    `✅ scanner done`,
    `scanned=${result.scanned}`,
    `deep=${result.deepChecked}/${result.survivors}`,
    `candidates=${result.candidates}`,
    `opened=${result.opened}`,
  ]
  if (result.openSkipped > 0) parts.push(`open-skipped=${result.openSkipped}`)
  if (result.openBlockedReason) parts.push(`blocked=${formatReason(result.openBlockedReason)}`)
  return parts.join(' | ')
}

function formatMonitorSummary(result: Awaited<ReturnType<typeof monitorPositions>>): string {
  return [
    `✅ monitor done`,
    `checked=${result.checked}`,
    `closed=${result.closed}`,
    `rebalanced=${result.rebalanced}`,
  ].join(' | ')
}

async function handleStop() {
  await reply('🛑 *EMERGENCY STOP initiated...*')
  await setBotState({ enabled: false })
  await syncAllMeteoraPositions().catch(err =>
    console.warn('[telegram-bot] pre-stop Meteora sync failed:', err)
  )

  const supabase = createServerClient()
  const { data: positions } = await supabase
    .from('lp_positions')
    .select('id, symbol, status, strategy_id, position_type')
    .in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry'])

  let closed = 0
  for (const pos of positions ?? []) {
    try {
      const ok = await closeLpPositionByKind(pos, 'emergency_stop')
      if (ok) closed++
    } catch (err) {
      console.error(`[telegram-bot] emergency close ${pos.id} failed:`, err)
    }
  }

  await pm2StopWorkers()

  await reply([
    `🛑 *Emergency stop complete.*`,
    ``,
    `• LP positions closed: ${closed}/${(positions ?? []).length}`,
    `• Worker services stopped (telegram-bot alive ✅)`,
    ``,
    `Send /restart to resume.`,
  ].join('\n'))
}

async function handleRestart() {
  await reply('⏳ *Restarting worker services...*')
  await setBotState({ enabled: true })
  await pm2RestartWorkers()
  const state = await getBotState()
  await reply([
    `✅ *All worker services restarted.*`,
    `Mode: ${state.dry_run ? '🟡 Dry-run' : '🟢 Live trading'}`,
    `Send /status for a full snapshot.`,
  ].join('\n'))
}

async function handleDry() {
  await setBotState({ dry_run: true })
  await reply('🟡 *Dry-run mode enabled.* No real on-chain transactions will be sent.')
}

async function handleLive() {
  await setBotState({ dry_run: false })
  await reply([
    `🟢 *Live trading enabled.*`,
    `⚠️ Real SOL transactions will be sent when a candidate qualifies.`,
    `Send /dry at any time to revert.`,
  ].join('\n'))
}

async function handleClose(positionId: string) {
  if (!positionId) {
    await reply('❌ Usage: `/close <position_id>`')
    return
  }
  await reply(`⏳ Closing LP position \`${positionId}\`...`)
  try {
    const supabase = createServerClient()
    let { data: pos, error } = await supabase
      .from('lp_positions').select('id, symbol, status, strategy_id, position_type').eq('id', positionId).single()
    if (error || !pos) {
      await syncAllMeteoraPositions().catch(err =>
        console.warn('[telegram-bot] close retry sync failed:', err)
      )
      const retry = await supabase
        .from('lp_positions').select('id, symbol, status, strategy_id, position_type').eq('id', positionId).single()
      pos = retry.data
      error = retry.error
    }
    if (error || !pos) {
      await reply(`❌ LP position \`${positionId}\` not found.`)
      return
    }
    if (pos.status === 'closed') {
      await reply(`ℹ️ \`${positionId}\` (${pos.symbol}) is already closed.`)
      return
    }
    const ok = await closeLpPositionByKind(pos, 'manual_telegram')
    await reply(ok
      ? `✅ \`${positionId}\` (${pos.symbol}) closed successfully.`
      : `❌ Failed to close \`${positionId}\` — check PM2 logs.`
    )
  } catch (err) {
    await reply(`❌ Close error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleAdd(args: string[]) {
  const { positionId, solAmount, error } = await resolveAddTarget(args)
  if (error || !positionId || solAmount === null) {
    await reply(`❌ ${error ?? 'Usage: `/add <position_id> <SOL>`'}`)
    return
  }

  await reply(`⏳ Adding ${solAmount} SOL to LP position \`${positionId}\`...`)
  const result = await addLiquidityToPosition(positionId, solAmount)

  if (result.success && result.dryRun) {
    await reply(`🟡 Dry-run: would add ${result.solAdded} SOL to ${result.symbol}. No transaction sent.`)
    return
  }

  if (result.success) {
    await reply([
      `✅ Added ${result.solAdded} SOL to ${result.symbol}.`,
      `Position: \`${positionId}\``,
      `Tx: \`${result.txSignature}\``,
    ].join('\n'))
    return
  }

  await reply(`❌ Add liquidity failed for ${result.symbol}: ${result.error ?? 'unknown error'}`)
}

async function handleRebalance(positionId: string) {
  if (!positionId) {
    await reply('❌ Usage: `/rebalance <position_id>`')
    return
  }

  await reply(`⏳ Rebalancing LP position \`${positionId}\`...`)
  const result = await rebalanceDlmmPosition(positionId, {
    reason: 'manual_rebalance',
    source: 'telegram_pm2',
  })

  if (result.reopened && result.newPositionId) {
    await reply([
      `✅ *Rebalance complete* for ${result.symbol}`,
      `Old: \`${result.oldPositionId}\` closed`,
      `New: \`${result.newPositionId}\` opened centered at current price`,
    ].join('\n'))
    return
  }

  if (result.closed) {
    await reply(`⚠️ \`${result.oldPositionId}\` closed but reopen failed: ${result.error ?? 'unknown error'}`)
    return
  }

  await reply(`❌ Rebalance skipped for \`${positionId}\`: ${result.error ?? 'unknown error'}`)
}

async function handleStatus() {
  const supabase = createServerClient()
  const state = await getBotState()
  const liveSnapshot = await fetchLiveMeteoraSnapshot()
  const liveSource: MeteoraLiveSourceStatus = {
    dlmmOk: liveSnapshot.dlmmOk,
    dammOk: liveSnapshot.dammOk,
  }
  const liveLp = liveSnapshot.positions
  const liveDlmmCount = liveLp.filter(p => p.position_type === 'dlmm').length
  const liveDammCount = liveLp.filter(p => p.position_type === 'damm-edge').length
  const wallet = await fetchWalletLiveBalances(liveLp.map(p => p.mint)).catch(() => null)
  const warning = liveSourceWarning(liveSource, {
    dlmm: liveSnapshot.dlmmError,
    damm: liveSnapshot.dammError,
  })

  const { data: openLp } = await supabase
    .from('lp_positions')
    .select('id, symbol, sol_deposited, opened_at, status, position_pubkey, strategy_id, position_type, claimable_fees_usd, position_value_usd, pnl_usd, metadata')
    .in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry'])
  const { data: scannerHealth } = await supabase
    .from('bot_health')
    .select('last_scan_at')
    .eq('service', 'scanner')
    .maybeSingle()

  const mergedOpenLp = mergeDbAndLiveLpPositions(openLp ?? [], liveLp, liveSource)
  const liveConfirmedCount = mergedOpenLp.filter(isLiveConfirmedPosition).length
  const cacheOnlyCount = mergedOpenLp.length - liveConfirmedCount

  const dlmmLines = mergedOpenLp
    .filter(p => !isDammLp(p))
    .map(p => {
    const mins = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000)
    const oor = p.status === 'out_of_range' ? ' ⚠️OOR' : ''
    const source = isLiveConfirmedPosition(p) ? ' | Meteora live' : ' | Supabase cache only'
    const fees = p.claimable_fees_usd ?? p.metadata?.claimable_fees_usd
    const value = p.position_value_usd ?? p.metadata?.position_value_usd
    const pnl = p.pnl_usd ?? p.metadata?.pnl_usd ?? p.metadata?.position_pnl_usd
    const pnlPct = p.pnl_pct ?? p.metadata?.pnl_pct ?? p.metadata?.position_pnl_pct
    const pnlText = pnl != null ? ` | pnl ${fmtUsd(pnl)}${pnlPct != null ? ` (${Number(pnlPct).toFixed(1)}%)` : ''}` : ''
    return `  • ${p.symbol} — ${(p.sol_deposited ?? 0).toFixed(3)} SOL | value ${fmtUsd(value)} | fees ${fmtUsd(fees)}${pnlText} | ${mins}min${oor}${source}`
  })

  const dammPositions = mergedOpenLp.filter(isDammLp)
  const dammLines = dammPositions.map(p => {
    const mins = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 60_000)
    const bondingCurvePct = p.metadata?.bonding_curve_pct
    const curve = bondingCurvePct != null ? ` | curve ${Number(bondingCurvePct).toFixed(1)}%` : ''
    const value = p.position_value_usd ?? p.metadata?.position_value_usd
    const valueText = value != null ? ` | value $${Number(value).toFixed(2)}` : ''
    const fees = p.claimable_fees_usd ?? p.metadata?.claimable_fees_usd
    const feesText = fees != null ? ` | fees $${Number(fees).toFixed(2)}` : ''
    const source = isLiveConfirmedPosition(p) || p.strategy_id === 'damm-live' ? ' | Meteora live' : ' | Supabase cache only'
    return `  • ${p.symbol} — ${(p.sol_deposited ?? 0).toFixed(3)} SOL | ${mins}min${curve}${valueText}${feesText}${source}`
  })

  await reply([
    `🤖 *Bot Status*`,
    `State: ${state.enabled ? '🟢 Running' : '🛑 Stopped'}`,
    `Mode:  ${state.dry_run ? '🟡 Dry-run' : '🟢 Live'}`,
    `Wallet: ${wallet ? wallet.sol.toFixed(4) : 'n/a'} SOL`,
    `Scanner tick: ${formatMinutesAgo(scannerHealth?.last_scan_at)}`,
    `Meteora live: ${liveLp.length} total (${liveDlmmCount} DLMM / ${liveDammCount} DAMM)`,
    ...(warning ? [warning] : []),
    `Supabase cache: ${(openLp ?? []).length} open rows`,
    `Rows below: ${liveConfirmedCount} live-confirmed / ${cacheOnlyCount} cache-only`,
    ``,
    `📊 *DLMM Positions (${dlmmLines.length})*`,
    ...(dlmmLines.length ? dlmmLines : ['  none']),
    ``,
    `🌱 *DAMM v2 Positions (${dammPositions.length})*`,
    ...(dammLines.length ? dammLines : ['  none']),
  ].join('\n'))
}

async function handlePositions() {
  const supabase = createServerClient()
  let liveLp: LiveMeteoraPosition[] = []
  let liveSource: MeteoraLiveSourceStatus = { dlmmOk: false, dammOk: false }
  let liveErrors: { dlmm?: string | null; damm?: string | null } = {}
  const syncResult = await syncAllMeteoraPositions().catch(err => {
    console.warn('[telegram-bot] /positions sync failed:', err)
    return null
  })
  if (syncResult) {
    liveLp = syncResult.positions
    liveSource = { dlmmOk: syncResult.dlmmOk, dammOk: syncResult.dammOk }
    liveErrors = { dlmm: syncResult.dlmmError, damm: syncResult.dammError }
  } else {
    const snapshot = await fetchLiveMeteoraSnapshot()
    liveLp = snapshot.positions
    liveSource = { dlmmOk: snapshot.dlmmOk, dammOk: snapshot.dammOk }
    liveErrors = { dlmm: snapshot.dlmmError, damm: snapshot.dammError }
  }
  const { data } = await supabase
    .from('lp_positions')
    .select('id, symbol, status, sol_deposited, pool_address, opened_at, position_pubkey, strategy_id, position_type, claimable_fees_usd, position_value_usd, pnl_usd, current_price, metadata')
    .in('status', ['active', 'open', 'out_of_range', 'orphaned', 'pending_retry'])
    .order('opened_at', { ascending: false })

  const positions = mergeDbAndLiveLpPositions(data ?? [], liveLp, liveSource)
  const warning = liveSourceWarning(liveSource, liveErrors)
  const liveConfirmedCount = positions.filter(isLiveConfirmedPosition).length
  const cacheOnlyCount = positions.length - liveConfirmedCount

  if (positions.length === 0) {
    await reply(warning ? `${warning}\n\n🏊 No cached open LP positions.` : '🏊 No open LP positions.')
    return
  }

  const lines = [
    `🏊 *LP Positions (${positions.length})*`,
    `Live-confirmed: ${liveConfirmedCount} | Cache-only: ${cacheOnlyCount}`,
    ``,
  ]
  if (warning) lines.push(warning, '')
  if (cacheOnlyCount > 0) {
    lines.push(`Cache-only rows are Supabase snapshots and may be stale until Meteora live fetch recovers.`, '')
  }
  for (const p of positions) {
    const age = Math.round((Date.now() - new Date(p.opened_at).getTime()) / 3_600_000 * 10) / 10
    const liveOnly = p._source === 'meteora-live'
    const source = isLiveConfirmedPosition(p) ? 'Meteora live' : 'Supabase cache only'
    const fees = p.claimable_fees_usd ?? p.metadata?.claimable_fees_usd
    const value = p.position_value_usd ?? p.metadata?.position_value_usd
    const pnl = p.pnl_usd ?? p.metadata?.pnl_usd ?? p.metadata?.position_pnl_usd
    const pnlPct = p.pnl_pct ?? p.metadata?.pnl_pct ?? p.metadata?.position_pnl_pct
    const pnlText = pnl != null ? ` | pnl ${fmtUsd(pnl)}${pnlPct != null ? ` (${Number(pnlPct).toFixed(1)}%)` : ''}` : ''
    const poolStats = p.metadata?.volume_24h_usd ? ` | vol24h ${fmtUsd(p.metadata.volume_24h_usd)}` : ''
    const actionLines = liveOnly
      ? [`  Run \`/orphans\` to create a manageable cache row`]
      : [
          `  ID: \`${p.id}\``,
          `  \`/close ${p.id}\``,
          ...(!isDammLp(p) ? [
            `  \`/rebalance ${p.id}\``,
            `  \`/add ${p.id} 0.05\``,
          ] : []),
        ]
    lines.push(
      `• ${String(p.id).slice(0, 8)} ${p.symbol} — ${p.status} | ${(p.sol_deposited ?? 0).toFixed(3)} SOL | ${age}h | ${source}`,
      `  value ${fmtUsd(value)} | fees ${fmtUsd(fees)}${pnlText} | price ${fmtPrice(p.current_price)}${poolStats}`,
      ...actionLines
    )
  }
  await reply(lines.join('\n'))
}

async function handleCandidates() {
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('candidates')
    .select('symbol, score, strategy_id, token_class, mc_at_scan, volume_24h, rugcheck_score, scanned_at, launchpad_source')
    .gte('scanned_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('score', { ascending: false })
    .limit(15)

  if (error) {
    await reply(`❌ Failed to fetch candidates: ${error.message}`)
    return
  }

  if (!data || data.length === 0) {
    await reply('🔍 No candidates found in the last 24h.')
    return
  }

  const lines = [`🔍 *Top Candidates — last 24h (${data.length})*`, ``]
  for (const c of data) {
    const age = Math.round((Date.now() - new Date(c.scanned_at).getTime()) / 60_000)
    const mc  = c.mc_at_scan >= 1_000_000
      ? `$${(c.mc_at_scan / 1_000_000).toFixed(1)}M`
      : `$${(c.mc_at_scan / 1_000).toFixed(0)}k`
    const vol = c.volume_24h >= 1_000_000
      ? `$${(c.volume_24h / 1_000_000).toFixed(1)}M`
      : `$${(c.volume_24h / 1_000).toFixed(0)}k`
    const source = c.launchpad_source ? ` [${c.launchpad_source}]` : ''
    lines.push(
      `• *${c.symbol}*${source} — score *${c.score}* | ${c.strategy_id}`,
      `  MC: ${mc} | vol: ${vol} | rug: ${c.rugcheck_score ?? '?'} | ${age}min ago`
    )
  }

  await reply(lines.join('\n'))
}

async function handleTick() {
  await reply('⏳ *Running monitor, then scanner...*')

  const monitorResult = await withTickTimeout(() => monitorPositions().then(formatMonitorSummary), 'monitor')
  const scannerResult = await withTickTimeout(() => runScanner().then(formatScannerSummary), 'scanner')

  await reply(['*Tick complete:*', `• ${monitorResult}`, `• ${scannerResult}`].join('\n'))
}

async function handleOrphans() {
  await reply('⏳ *Reconciling wallet positions from Meteora...*')
  try {
    const result = await detectAllOrphanedPositions()
    await reply(
      `✅ Meteora reconcile complete.\n` +
      `Live: ${result.live} (${result.dlmmLive} DLMM / ${result.dammLive} DAMM)\n` +
      `Updated cache rows: ${result.updated}\n` +
      `Marked externally closed: ${result.externallyClosed}\n` +
      `Inserted missing cache rows: ${result.inserted}`,
    )
  } catch (err) {
    await reply(`❌ Meteora reconcile error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function handleHelp() {
  await reply([
    `*Meteoracle Bot Commands*`,
    ``,
    `/stop — emergency stop (closes all LP positions, stops workers)`,
    `/restart — resume all worker services`,
    `/dry — switch to dry-run mode`,
    `/live — switch to live trading`,
    `/status — snapshot: bot state + DLMM + DAMM v2 positions`,
    `/positions — list live-confirmed and cached LP rows`,
    `/close <id> — force-close an LP position`,
    `/add <id> <SOL> — add SOL liquidity to a DLMM position`,
    `/rebalance <id> — close + reopen a DLMM position centered at current price`,
    `/tick — manually trigger scanner + monitor`,
    `/orphans — manually run orphan detector`,
    `/candidates — top candidates from last 24h sorted by score`,
    `/help — this message`,
  ].join('\n'))
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const text = update.message?.text?.trim() ?? ''
  const chatId = update.message?.chat?.id
  const fromId = update.message?.from?.id

  if (!text) return
  if (!isTelegramCommandAllowed(fromId, chatId, ALLOWED_USER_IDS)) {
    console.warn(`[telegram-bot] ignored unauthorized command from user=${fromId ?? 'unknown'} chat=${chatId ?? 'unknown'}`)
    return
  }

  const [rawCmd, ...args] = text.split(/\s+/)
  const cmd = rawCmd.toLowerCase().replace(/^\//, '')

  console.log(`[telegram-bot] command: /${cmd}${args.length ? ' ' + args.join(' ') : ''}`)

  switch (cmd) {
    case 'stop': await handleStop(); break
    case 'restart': await handleRestart(); break
    case 'dry': await handleDry(); break
    case 'live': await handleLive(); break
    case 'close': await handleClose(args[0] ?? ''); break
    case 'add': await handleAdd(args); break
    case 'rebalance': await handleRebalance(args[0] ?? ''); break
    case 'status': await handleStatus(); break
    case 'positions': await handlePositions(); break
    case 'candidates': await handleCandidates(); break
    case 'tick': await handleTick(); break
    case 'orphans': await handleOrphans(); break
    case 'help': await handleHelp(); break
    default:
      await reply(`❌ Unknown command: /${cmd}. Send /help for the list.`)
  }
}

async function main(): Promise<void> {
  console.log('[telegram-bot] starting long-poll loop...')
  await drainPendingUpdates()

  while (true) {
    const updates = await getUpdates()
    for (const update of updates) {
      lastUpdateId = update.update_id
      await processUpdate(update)
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }
}

main().catch(err => {
  console.error('[telegram-bot] fatal:', err)
  process.exit(1)
})
