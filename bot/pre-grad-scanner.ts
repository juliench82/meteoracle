/**
 * pre-grad-scanner.ts
 *
 * Event-driven pre-graduation scanner using Helius logsSubscribe WebSocket.
 * Derives the WSS URL from the existing HELIUS_RPC_URL (https → wss).
 *
 * ENV VARS:
 *   HELIUS_RPC_URL            required
 *   PRE_GRAD_WATCH_WINDOW_H   watchlist TTL hours (default: 6)
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import WebSocket from 'ws'
import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'
import { checkHolders } from '@/lib/helius'
import { sendStartupAlert } from './startup-alert'

const PUMP_PROGRAM_ID        = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const INITIAL_VIRTUAL_SOL    = 30_000_000_000n
const GRADUATION_VIRTUAL_SOL = 115_000_000_000n
const SEEN_CACHE_TTL_MS      = 5 * 60 * 1_000
const RECONNECT_DELAY_MS     = 5_000
const WATCH_HOURS            = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const cfg                    = PRE_GRAD_STRATEGY.scanner

/** https://mainnet.helius-rpc.com/?api-key=X → wss://mainnet.helius-rpc.com/?api-key=X */
function toWssUrl(httpUrl: string): string {
  return httpUrl.replace(/^https?:\/\//, 'wss://')
}

function decodeBondingCurve(data: Buffer): { progressPct: number; complete: boolean } | null {
  if (data.length < 49) return null
  const complete = data[48] === 1
  if (complete) return { progressPct: 100, complete: true }
  const virtualSolReserves = data.readBigUInt64LE(16)
  if (virtualSolReserves <= INITIAL_VIRTUAL_SOL) return { progressPct: 0, complete: false }
  const num = virtualSolReserves - INITIAL_VIRTUAL_SOL
  const den = GRADUATION_VIRTUAL_SOL - INITIAL_VIRTUAL_SOL
  const pct = Math.min(100, Math.max(0, Number(num * 10000n / den) / 100))
  return { progressPct: pct, complete: false }
}

async function fetchBondingCurveProgress(mint: string): Promise<number | null> {
  const rpcUrl = process.env.HELIUS_RPC_URL
  if (!rpcUrl) return null
  const { PublicKey } = await import('@solana/web3.js')
  const [curvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    new PublicKey(PUMP_PROGRAM_ID)
  )
  try {
    const resp = await axios.post(
      rpcUrl,
      { jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [curvePda.toString(), { encoding: 'base64' }] },
      { timeout: 8_000 }
    )
    const raw = resp.data?.result?.value?.data?.[0]
    if (!raw) return null
    const decoded = decodeBondingCurve(Buffer.from(raw, 'base64'))
    return decoded ? decoded.progressPct : null
  } catch {
    return null
  }
}

function extractMintFromLogs(logs: string[]): string | null {
  for (const log of logs) {
    const m = log.match(/mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/)
    if (m) return m[1]
  }
  return null
}

const seenCache = new Map<string, number>()
function shouldProcess(mint: string): boolean {
  const last = seenCache.get(mint)
  if (last && Date.now() - last < SEEN_CACHE_TTL_MS) return false
  seenCache.set(mint, Date.now())
  if (seenCache.size > 1000) {
    const cutoff = Date.now() - SEEN_CACHE_TTL_MS
    for (const [k, v] of seenCache) if (v < cutoff) seenCache.delete(k)
  }
  return true
}

async function processMint(mint: string): Promise<void> {
  if (!shouldProcess(mint)) return
  const progressPct = await fetchBondingCurveProgress(mint)
  if (progressPct === null) return
  const symbol = mint.slice(0, 8)
  if (progressPct < cfg.minBondingProgress || progressPct > cfg.maxBondingProgress) {
    if (progressPct >= 80) console.log(`[pre-grad] ${symbol}... curve=${progressPct.toFixed(1)}% — outside window`)
    return
  }
  console.log(`[pre-grad] ${symbol}... curve=${progressPct.toFixed(1)}% IN WINDOW — checking holders`)
  const holderData   = await checkHolders(mint)
  const holderCount  = holderData.holderCount
  const topHolderPct = holderData.topHolderPct
  if (holderCount > 0 && holderCount < cfg.minHolders) {
    console.log(`[pre-grad] ${symbol}... skip: holders ${holderCount} < ${cfg.minHolders}`)
    return
  }
  if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
    console.log(`[pre-grad] ${symbol}... skip: topHolder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
    return
  }
  const supabase = createServerClient()
  const { data: existing } = await supabase
    .from('pre_grad_watchlist')
    .select('id, status, first_seen_at, bonding_pct_at_first_seen')
    .eq('mint', mint)
    .maybeSingle()
  if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) return
  const now = new Date().toISOString()
  let velocityPctPerMin = 0
  if (existing?.first_seen_at && existing?.bonding_pct_at_first_seen != null) {
    const elapsedMin = (Date.now() - new Date(existing.first_seen_at).getTime()) / 60_000
    const pctGained  = progressPct - (existing.bonding_pct_at_first_seen as number)
    velocityPctPerMin = elapsedMin > 0 ? pctGained / elapsedMin : 0
    if (cfg.minVelocitySolPerMin > 0 && velocityPctPerMin < cfg.minVelocitySolPerMin) {
      console.log(`[pre-grad] ${symbol}... skip: velocity ${velocityPctPerMin.toFixed(3)} < ${cfg.minVelocitySolPerMin}`)
      return
    }
  }
  const upsertData: Record<string, unknown> = {
    mint, symbol, name: symbol, volume_1h_usd: 0, status: 'watching',
    bonding_curve_pct: progressPct, holder_count: holderCount,
    top_holder_pct: topHolderPct, dev_wallet_pct: 0,
    velocity_pct_per_min: velocityPctPerMin,
  }
  if (!existing) {
    upsertData.detected_at               = now
    upsertData.first_seen_at             = now
    upsertData.bonding_pct_at_first_seen = progressPct
  }
  const { error } = await supabase
    .from('pre_grad_watchlist')
    .upsert(upsertData, { onConflict: 'mint', ignoreDuplicates: false })
  if (error) {
    console.error(`[pre-grad] upsert error for ${symbol}:`, error.message)
  } else if (!existing) {
    console.log(`[pre-grad] WATCHLIST ADD: ${symbol}... (${mint}) curve=${progressPct.toFixed(1)}% holders=${holderCount} topHolder=${topHolderPct.toFixed(1)}%`)
  } else {
    console.log(`[pre-grad] UPDATE: ${symbol}... curve=${progressPct.toFixed(1)}% vel=${velocityPctPerMin.toFixed(3)}/min`)
  }
}

async function expireStale(): Promise<void> {
  const supabase = createServerClient()
  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase.from('pre_grad_watchlist').update({ status: 'expired' })
    .eq('status', 'watching').lt('detected_at', cutoff)
}

function connect(wssUrl: string): void {
  console.log('[pre-grad] connecting to Helius WSS...')
  const ws = new WebSocket(wssUrl)
  ws.on('open', () => {
    console.log('[pre-grad] WSS connected — subscribing to pump.fun logs')
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [PUMP_PROGRAM_ID] }, { commitment: 'processed' }],
    }))
  })
  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.id === 1 && msg.result !== undefined) {
        console.log(`[pre-grad] subscribed (id=${msg.result}) — streaming pump.fun txns`)
        return
      }
      const logs: string[] = msg?.params?.result?.value?.logs ?? []
      const mint = extractMintFromLogs(logs)
      if (mint) processMint(mint).catch(() => {})
    } catch { /* ignore parse errors */ }
  })
  ws.on('error', (err: Error) => console.error('[pre-grad] WSS error:', err.message))
  ws.on('close', () => {
    console.warn(`[pre-grad] WSS closed — reconnecting in ${RECONNECT_DELAY_MS / 1000}s`)
    setTimeout(() => connect(wssUrl), RECONNECT_DELAY_MS)
  })
}

export async function runPreGradScanner(): Promise<string> {
  try {
    const supabase = createServerClient()
    const { count } = await supabase
      .from('pre_grad_watchlist').select('*', { count: 'exact', head: true }).eq('status', 'watching')
    return `ok pre-grad-scanner (watching=${count ?? 0})`
  } catch (err) {
    return `err pre-grad-scanner: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function main(): Promise<void> {
  await sendStartupAlert('pre-grad-scanner')
  const rpcUrl = process.env.HELIUS_RPC_URL
  if (!rpcUrl) {
    console.error('[pre-grad] HELIUS_RPC_URL not set')
    process.exit(1)
  }
  const wssUrl = toWssUrl(rpcUrl)
  console.log(`[pre-grad] starting WSS scanner — window ${cfg.minBondingProgress}-${cfg.maxBondingProgress}% holders>=${cfg.minHolders} topHolder<=${cfg.maxTopHolderPct}%`)
  await expireStale()
  setInterval(expireStale, 3_600_000)
  connect(wssUrl)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})
