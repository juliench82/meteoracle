/**
 * pre-grad-scanner.ts
 *
 * Polls all active pump.fun bonding curve accounts via Helius
 * getProgramAccountsV2 every 30s. Decodes each account on-chain
 * to get exact bonding progress %. No pump.fun API dependency.
 *
 * Flow:
 *   getProgramAccountsV2 (pump.fun program, paginated)
 *     → decode bonding curve % from each account
 *     → filter 88–98% window
 *     → checkHolders via Helius DAS
 *     → upsert pre_grad_watchlist
 *
 * ENV VARS:
 *   HELIUS_RPC_URL            required
 *   PRE_GRAD_WATCH_WINDOW_H   watchlist TTL hours (default: 6)
 *   PRE_GRAD_MIN_HOLDERS      default 40 (raise to 80-100 once first buy confirmed)
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
const PUMP_PROGRAM_ID        = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const INITIAL_VIRTUAL_SOL    = 30_000_000_000n
const GRADUATION_VIRTUAL_SOL = 115_000_000_000n
const PAGE_LIMIT             = 1000

function decodeBondingCurve(data: Buffer): { progressPct: number; complete: boolean; mint: string } | null {
  if (data.length < 81) return null
  const complete = data[48] === 1
  if (complete) return null  // already graduated, skip
  const virtualSolReserves = data.readBigUInt64LE(16)
  if (virtualSolReserves <= INITIAL_VIRTUAL_SOL) return { progressPct: 0, complete: false, mint: '' }
  const num        = virtualSolReserves - INITIAL_VIRTUAL_SOL
  const den        = GRADUATION_VIRTUAL_SOL - INITIAL_VIRTUAL_SOL
  const progressPct = Math.min(100, Math.max(0, Number(num * 10000n / den) / 100))
  // mint pubkey is at offset 49–80 (32 bytes)
  const mint = Buffer.from(data.subarray(49, 81)).toString('base64')  // decoded to base58 below
  return { progressPct, complete: false, mint }
}

async function fetchAllBondingCurves(): Promise<Array<{ mint: string; progressPct: number }>> {
  const rpcUrl = process.env.HELIUS_RPC_URL
  if (!rpcUrl) throw new Error('HELIUS_RPC_URL not set')

  const { PublicKey } = await import('@solana/web3.js')
  const results: Array<{ mint: string; progressPct: number }> = []
  let cursor: string | undefined
  let page = 0

  while (true) {
    page++
    const params: Record<string, unknown> = {
      programId: PUMP_PROGRAM_ID,
      limit:     PAGE_LIMIT,
      encoding:  'base64',
      filters:   [{ dataSize: 165 }],  // pump.fun BondingCurve account size
    }
    if (cursor) params.cursor = cursor

    const resp = await axios.post(
      rpcUrl,
      { jsonrpc: '2.0', id: page, method: 'getProgramAccountsV2', params: [PUMP_PROGRAM_ID, params] },
      { timeout: 30_000 }
    )

    const accounts: Array<{ pubkey: string; account: { data: [string, string] } }> =
      resp.data?.result?.accounts ?? resp.data?.result ?? []

    console.log(`[pre-grad] page ${page}: ${accounts.length} accounts fetched (total so far: ${results.length + accounts.length})`)

    for (const acc of accounts) {
      try {
        const buf     = Buffer.from(acc.account.data[0], 'base64')
        const decoded = decodeBondingCurve(buf)
        if (!decoded || decoded.progressPct === 0) continue

        // Extract mint pubkey from account data bytes 49-80
        const mintBytes = buf.subarray(49, 81)
        const mint      = new PublicKey(mintBytes).toString()
        results.push({ mint, progressPct: decoded.progressPct })
      } catch {
        // skip malformed accounts
      }
    }

    cursor = resp.data?.result?.cursor
    if (!cursor || accounts.length < PAGE_LIMIT) break
  }

  return results
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
    .select('id, status, first_seen_at, bonding_pct_at_first_seen')
    .eq('mint', mint)
    .maybeSingle()

  if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) return

  const now = new Date().toISOString()
  let velocityPctPerMin = 0

  if (existing?.first_seen_at && existing?.bonding_pct_at_first_seen != null) {
    const elapsedMin  = (Date.now() - new Date(existing.first_seen_at).getTime()) / 60_000
    const pctGained   = progressPct - (existing.bonding_pct_at_first_seen as number)
    velocityPctPerMin = elapsedMin > 0 ? pctGained / elapsedMin : 0
    if (cfg.minVelocitySolPerMin > 0 && velocityPctPerMin < cfg.minVelocitySolPerMin) {
      console.log(`[pre-grad] ${shortSym}... skip: velocity ${velocityPctPerMin.toFixed(3)} < ${cfg.minVelocitySolPerMin}`)
      return
    }
  }

  const upsertData: Record<string, unknown> = {
    mint,
    symbol:               shortSym,
    name:                 shortSym,
    volume_1h_usd:        0,
    status:               'watching',
    bonding_curve_pct:    progressPct,
    holder_count:         holderCount,
    top_holder_pct:       topHolderPct,
    dev_wallet_pct:       0,
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
    console.error(`[pre-grad] upsert error for ${shortSym}:`, error.message)
  } else if (!existing) {
    console.log(`[pre-grad] WATCHLIST ADD: ${shortSym}... (${mint}) curve=${progressPct.toFixed(1)}% holders=${holderCount} topHolder=${topHolderPct.toFixed(1)}%`)
  } else {
    console.log(`[pre-grad] UPDATE: ${shortSym}... curve=${progressPct.toFixed(1)}% vel=${velocityPctPerMin.toFixed(3)}/min`)
  }
}

async function expireStale(): Promise<void> {
  const supabase = createServerClient()
  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase.from('pre_grad_watchlist').update({ status: 'expired' })
    .eq('status', 'watching').lt('detected_at', cutoff)
}

async function tick(): Promise<void> {
  console.log(`[pre-grad] poll via getProgramAccountsV2 curve=${cfg.minBondingProgress}-${cfg.maxBondingProgress}% holders>=${cfg.minHolders} topHolder<=${cfg.maxTopHolderPct}%`)
  let curves: Array<{ mint: string; progressPct: number }> = []
  try {
    curves = await fetchAllBondingCurves()
  } catch (err) {
    console.error('[pre-grad] fetchAllBondingCurves error:', err instanceof Error ? err.message : err)
    return
  }

  console.log(`[pre-grad] ${curves.length} active bonding curves total`)

  const candidates = curves.filter(
    c => c.progressPct >= cfg.minBondingProgress && c.progressPct <= cfg.maxBondingProgress
  )
  console.log(`[pre-grad] ${candidates.length} in window (${cfg.minBondingProgress}-${cfg.maxBondingProgress}%)`)

  let added = 0
  for (const { mint, progressPct } of candidates) {
    console.log(`[pre-grad] ${mint.slice(0,8)}... curve=${progressPct.toFixed(1)}% IN WINDOW — checking holders`)
    await processCandidate(mint, progressPct)
    added++
  }

  console.log(`[pre-grad] tick done total=${curves.length} in-window=${candidates.length} added=${added}`)
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
  console.log(`[pre-grad] starting REST poll scanner — every ${POLL_INTERVAL_MS / 1000}s, window ${cfg.minBondingProgress}-${cfg.maxBondingProgress}% minHolders=${cfg.minHolders}`)
  await expireStale()
  setInterval(expireStale, 3_600_000)
  await tick()
  setInterval(tick, POLL_INTERVAL_MS)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})
