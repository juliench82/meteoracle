/**
 * pre-grad-scanner.ts
 *
 * Polls pump.fun /coins every 30s (limit=200, sorted by last_trade_timestamp).
 * Calculates bonding curve progress from virtual_sol_reserves.
 *
 * DB columns (pre_grad_watchlist):
 *   id, mint, symbol, name, detected_at, bonding_progress, market_cap_usd,
 *   volume_1h_usd, holder_count, graduated_at, status, reject_reason,
 *   updated_at, bonding_curve_pct (legacy — keep for dashboard compat)
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'
import { checkHolders } from '@/lib/helius'
import { sendStartupAlert } from './startup-alert'

const POLL_INTERVAL_MS       = 30_000
const WATCH_HOURS            = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const cfg                    = PRE_GRAD_STRATEGY.scanner
const INITIAL_VIRTUAL_SOL    = 30_000_000_000n
const GRADUATION_VIRTUAL_SOL = 115_000_000_000n

const PUMP_COINS_URL =
  'https://frontend-api-v3.pump.fun/coins?offset=0&limit=200&sort=last_trade_timestamp&order=desc&includeNsfw=false'

function calculateProgress(virtualSolReserves: number): number {
  if (!virtualSolReserves) return 0
  const num = BigInt(virtualSolReserves) - INITIAL_VIRTUAL_SOL
  const den = GRADUATION_VIRTUAL_SOL - INITIAL_VIRTUAL_SOL
  if (num <= 0n) return 0
  return Math.min(100, Math.max(0, Number(num * 10000n / den) / 100))
}

async function fetchCandidates(): Promise<Array<{ mint: string; progressPct: number }>> {
  try {
    const { data } = await axios.get<any[]>(PUMP_COINS_URL, {
      timeout: 10_000,
      headers: { 'User-Agent': 'meteoracle-scanner/1.0' },
    })
    if (!Array.isArray(data)) return []
    return data
      .filter((c: any) => !c.complete)
      .map((c: any) => ({
        mint:        c.mint as string,
        progressPct: calculateProgress(c.virtual_sol_reserves),
      }))
      .filter(c => c.progressPct >= cfg.minBondingProgress && c.progressPct <= cfg.maxBondingProgress)
  } catch (err) {
    console.warn('[pre-grad] pump.fun fetch failed:', err instanceof Error ? err.message : err)
    return []
  }
}

async function processCandidate(mint: string, progressPct: number): Promise<void> {
  const shortSym = mint.slice(0, 8)

  const holderData   = await checkHolders(mint)
  const holderCount  = holderData.holderCount
  const topHolderPct = holderData.topHolderPct

  if (holderCount > 0 && holderCount < cfg.minHolders) {
    console.log(`[pre-grad] ${shortSym}... skip: holders ${holderCount} < ${cfg.minHolders}`)
    return
  }
  if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
    console.log(`[pre-grad] ${shortSym}... skip: topHolder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
    return
  }

  const supabase = createServerClient()
  const { data: existing } = await supabase
    .from('pre_grad_watchlist')
    .select('id, status, detected_at, bonding_progress')
    .eq('mint', mint)
    .maybeSingle()

  if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) return

  const now = new Date().toISOString()

  // only columns that actually exist in the DB schema
  const upsertData: Record<string, unknown> = {
    mint,
    symbol:           shortSym,
    name:             shortSym,
    volume_1h_usd:    0,
    status:           'watching',
    bonding_progress: progressPct,   // ← correct column name
    holder_count:     holderCount,
    updated_at:       now,
  }
  if (!existing) {
    upsertData.detected_at = now
  }

  const { error } = await supabase
    .from('pre_grad_watchlist')
    .upsert(upsertData, { onConflict: 'mint', ignoreDuplicates: false })

  if (error) {
    console.error(`[pre-grad] upsert error for ${shortSym}:`, error.message)
  } else if (!existing) {
    console.log(`[pre-grad] WATCHLIST ADD: ${shortSym}... (${mint}) curve=${progressPct.toFixed(1)}% holders=${holderCount} topHolder=${topHolderPct.toFixed(1)}%`)
  } else {
    console.log(`[pre-grad] UPDATE: ${shortSym}... curve=${progressPct.toFixed(1)}%`)
  }
}

async function expireStale(): Promise<void> {
  const supabase = createServerClient()
  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase.from('pre_grad_watchlist').update({ status: 'expired' })
    .eq('status', 'watching').lt('detected_at', cutoff)
}

async function tick(): Promise<void> {
  console.log(`[pre-grad] poll pump.fun REST curve=${cfg.minBondingProgress}-${cfg.maxBondingProgress}% holders>=${cfg.minHolders} topHolder<=${cfg.maxTopHolderPct}%`)

  const candidates = await fetchCandidates()
  console.log(`[pre-grad] ${candidates.length} candidates in window`)

  for (const { mint, progressPct } of candidates) {
    console.log(`[pre-grad] ${mint.slice(0, 8)}... curve=${progressPct.toFixed(1)}% IN WINDOW — checking holders`)
    await processCandidate(mint, progressPct)
  }

  console.log(`[pre-grad] tick done in-window=${candidates.length}`)
}

export async function runPreGradScanner(): Promise<string> {
  try {
    await tick()
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
  console.log(`[pre-grad] starting — every ${POLL_INTERVAL_MS / 1000}s, window ${cfg.minBondingProgress}-${cfg.maxBondingProgress}% minHolders=${cfg.minHolders}`)
  await expireStale()
  setInterval(expireStale, 3_600_000)
  await tick()
  setInterval(tick, POLL_INTERVAL_MS)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})
