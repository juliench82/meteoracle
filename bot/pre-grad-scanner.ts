/**
 * pre-grad-scanner.ts
 *
 * Polls pump.fun public coins endpoint every 30s.
 * Returns mint + bonding_curve + volume + holder_count in one call.
 * No WSS, no RPC spam, no paid tier. One endpoint, one loop.
 *
 * Flow:
 *   GET pump.fun/coins (sorted by bonding_curve desc, limit 50)
 *     → filter 88–98% bonding progress
 *     → filter volume_5m >= threshold
 *     → checkHolders via Helius DAS (holders ≥ 100, topHolder ≤ 12%)
 *     → upsert pre_grad_watchlist
 *
 * ENV VARS:
 *   HELIUS_RPC_URL            required
 *   PRE_GRAD_WATCH_WINDOW_H   watchlist TTL hours (default: 6)
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

const POLL_INTERVAL_MS = 30_000
const WATCH_HOURS      = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const cfg              = PRE_GRAD_STRATEGY.scanner

// pump.fun returns bonding_curve as 0–1 float — multiply by 100 for %
const PUMP_COINS_URL =
  'https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=bonding_curve&order=desc&includeNsfw=false'

interface PumpCoin {
  mint:              string
  symbol:            string
  name:              string
  bonding_curve:     number   // 0–1
  volume_5m:         number
  usd_market_cap:    number
  reply_count:       number
}

async function fetchPumpCoins(): Promise<PumpCoin[]> {
  try {
    const resp = await axios.get<PumpCoin[]>(PUMP_COINS_URL, {
      timeout: 10_000,
      headers: { 'User-Agent': 'meteoracle-scanner/1.0' },
    })
    return Array.isArray(resp.data) ? resp.data : []
  } catch (err) {
    console.warn('[pre-grad] pump.fun fetch failed:', err instanceof Error ? err.message : err)
    return []
  }
}

async function processCandidate(coin: PumpCoin): Promise<void> {
  const progressPct  = coin.bonding_curve * 100
  const { mint, symbol, name } = coin
  const shortSym = symbol || mint.slice(0, 8)

  if (progressPct < cfg.minBondingProgress || progressPct > cfg.maxBondingProgress) return

  if (cfg.minVolume5mUsd > 0 && (coin.volume_5m ?? 0) < cfg.minVolume5mUsd) {
    console.log(`[pre-grad] ${shortSym} skip: vol5m $${coin.volume_5m?.toFixed(0)} < $${cfg.minVolume5mUsd}`)
    return
  }

  console.log(`[pre-grad] ${shortSym} curve=${progressPct.toFixed(1)}% IN WINDOW — checking holders`)

  const holderData   = await checkHolders(mint)
  const holderCount  = holderData.holderCount
  const topHolderPct = holderData.topHolderPct

  if (holderCount > 0 && holderCount < cfg.minHolders) {
    console.log(`[pre-grad] ${shortSym} skip: holders ${holderCount} < ${cfg.minHolders}`)
    return
  }
  if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
    console.log(`[pre-grad] ${shortSym} skip: topHolder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
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
      console.log(`[pre-grad] ${shortSym} skip: velocity ${velocityPctPerMin.toFixed(3)} < ${cfg.minVelocitySolPerMin}`)
      return
    }
  }

  const upsertData: Record<string, unknown> = {
    mint, symbol: shortSym, name: name || shortSym,
    volume_1h_usd:        coin.volume_5m ?? 0,
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
    console.log(
      `[pre-grad] WATCHLIST ADD: ${shortSym} (${mint})` +
      ` curve=${progressPct.toFixed(1)}% holders=${holderCount} topHolder=${topHolderPct.toFixed(1)}%`
    )
  } else {
    console.log(`[pre-grad] UPDATE: ${shortSym} curve=${progressPct.toFixed(1)}% vel=${velocityPctPerMin.toFixed(3)}/min`)
  }
}

async function expireStale(): Promise<void> {
  const supabase = createServerClient()
  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase.from('pre_grad_watchlist').update({ status: 'expired' })
    .eq('status', 'watching').lt('detected_at', cutoff)
}

async function tick(): Promise<void> {
  const coins = await fetchPumpCoins()
  if (coins.length === 0) {
    console.log('[pre-grad] no coins returned from pump.fun')
    return
  }
  // coins are sorted by bonding_curve desc — stop as soon as we drop below window
  const candidates = coins.filter(c => {
    const pct = c.bonding_curve * 100
    return pct >= cfg.minBondingProgress && pct <= cfg.maxBondingProgress
  })
  console.log(`[pre-grad] poll: ${coins.length} coins, ${candidates.length} in ${cfg.minBondingProgress}-${cfg.maxBondingProgress}% window`)
  for (const coin of candidates) {
    await processCandidate(coin)
  }
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
  console.log(`[pre-grad] starting REST poll scanner — every ${POLL_INTERVAL_MS / 1000}s, window ${cfg.minBondingProgress}-${cfg.maxBondingProgress}%`)
  await expireStale()
  setInterval(expireStale, 3_600_000)
  await tick()
  setInterval(tick, POLL_INTERVAL_MS)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})
