/**
 * pre-grad-scanner.ts
 *
 * Polls pump.fun frontend API for tokens approaching graduation.
 * For each candidate, enriches with pump.fun coin detail:
 *   - bonding_curve_pct (88-98% window)
 *   - dev_wallet_pct    (≤ 3%)
 *   - holder_count      (≥ 100)
 *   - top_holder_pct    (≤ 12%)
 *
 * No API key required. Uses pump.fun public frontend API.
 *
 * OPTIONAL ENV VARS:
 *   PRE_GRAD_POLL_INTERVAL_S  — poll interval seconds (default: 60)
 *   PRE_GRAD_WATCH_WINDOW_H   — watchlist TTL hours (default: 6)
 *   PRE_GRAD_MIN_MCAP         — min market cap USD (default: 50000)
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'

const PUMP_API    = 'https://frontend-api.pump.fun/coins'
const POLL_SEC    = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S ?? '60')
const WATCH_HOURS = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const MIN_MCAP    = parseFloat(process.env.PRE_GRAD_MIN_MCAP ?? '50000')
const cfg         = PRE_GRAD_STRATEGY.scanner

// Mimic a real browser to avoid Cloudflare blocking datacenter IPs
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://pump.fun/',
  'Origin': 'https://pump.fun',
}

interface PumpListItem {
  mint:                  string
  symbol:                string
  name:                  string
  usd_market_cap?:       number
  market_cap?:           number
  bonding_curve_pct?:    number
  complete:              boolean
  created_timestamp?:    number
  holder_count?:         number
  top_holder_pct?:       number
  creator?:              string
  top_holders?:          Array<{ wallet: string; pct: number }>
  virtual_sol_reserves?: number
  virtual_token_reserves?: number
  king_of_the_hill?:     number
  reply_count?:          number
}

interface Candidate {
  mint:      string
  symbol:    string
  name:      string
  marketCap: number
  volumeUsd: number
}

function getDevWalletPct(coin: PumpListItem): number {
  if (!coin.creator) return 0
  if (coin.top_holders && coin.top_holders.length > 0) {
    const devEntry = coin.top_holders.find(h => h.wallet === coin.creator)
    return devEntry?.pct ?? 0
  }
  return 0
}

async function fetchActivePumpTokens(): Promise<Candidate[]> {
  const res = await axios.get<PumpListItem[]>(PUMP_API, {
    params: {
      limit:       50,
      sort:        'last_trade_timestamp',
      order:       'DESC',
      includeNsfw: false,
    },
    headers: BROWSER_HEADERS,
    timeout: 15_000,
  })

  const items = res.data ?? []

  return items
    .filter(item => !item.complete)
    .filter(item => {
      const mc = item.usd_market_cap ?? item.market_cap ?? 0
      return mc >= MIN_MCAP
    })
    .map(item => ({
      mint:      item.mint,
      symbol:    item.symbol ?? '',
      name:      item.name ?? '',
      marketCap: item.usd_market_cap ?? item.market_cap ?? 0,
      volumeUsd: 0,
    }))
}

async function fetchPumpCoin(mint: string): Promise<PumpListItem | null> {
  try {
    const res = await axios.get<PumpListItem>(`${PUMP_API}/${mint}`, {
      headers: BROWSER_HEADERS,
      timeout: 6_000,
    })
    return res.data ?? null
  } catch {
    return null
  }
}

async function upsertWatchlist(candidates: Candidate[]): Promise<number> {
  const supabase = createServerClient()
  let added = 0

  for (const c of candidates) {
    const { data: existing } = await supabase
      .from('pre_grad_watchlist')
      .select('id, status, first_seen_at, bonding_pct_at_first_seen, bonding_curve_pct')
      .eq('mint', c.mint)
      .maybeSingle()

    if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) continue

    const coin = await fetchPumpCoin(c.mint)
    if (!coin) {
      console.log(`[pre-grad] ${c.symbol} — skip: pump.fun detail unavailable`)
      continue
    }

    if (coin.complete) {
      console.log(`[pre-grad] ${c.symbol} — skip: already graduated`)
      continue
    }

    const bondingPct   = coin.bonding_curve_pct ?? 0
    const holderCount  = coin.holder_count ?? 0
    const topHolderPct = coin.top_holder_pct ?? 0
    const devPct       = getDevWalletPct(coin)

    if (bondingPct < cfg.minBondingProgress) {
      console.log(`[pre-grad] ${c.symbol} — skip: curve ${bondingPct.toFixed(1)}% < ${cfg.minBondingProgress}%`)
      continue
    }
    if (bondingPct > cfg.maxBondingProgress) {
      console.log(`[pre-grad] ${c.symbol} — skip: curve ${bondingPct.toFixed(1)}% > ${cfg.maxBondingProgress}%`)
      continue
    }
    if (holderCount > 0 && holderCount < cfg.minHolders) {
      console.log(`[pre-grad] ${c.symbol} — skip: holders ${holderCount} < ${cfg.minHolders}`)
      continue
    }
    if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
      console.log(`[pre-grad] ${c.symbol} — skip: top holder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
      continue
    }
    if (devPct > cfg.maxDevWalletPct) {
      console.log(`[pre-grad] ${c.symbol} — skip: dev wallet ${devPct.toFixed(1)}% > ${cfg.maxDevWalletPct}%`)
      continue
    }

    const now = new Date().toISOString()
    let velocitySolPerMin = 0

    if (existing?.first_seen_at && existing?.bonding_pct_at_first_seen != null) {
      const elapsedMin = (Date.now() - new Date(existing.first_seen_at).getTime()) / 60_000
      const pctGained  = bondingPct - (existing.bonding_pct_at_first_seen as number)
      velocitySolPerMin = elapsedMin > 0 ? pctGained / elapsedMin : 0

      if (cfg.minVelocitySolPerMin > 0 && velocitySolPerMin < cfg.minVelocitySolPerMin) {
        console.log(`[pre-grad] ${c.symbol} — skip: velocity ${velocitySolPerMin.toFixed(3)} pct/min < ${cfg.minVelocitySolPerMin}`)
        continue
      }
    }

    const upsertData: Record<string, unknown> = {
      mint:                  c.mint,
      symbol:                c.symbol,
      name:                  c.name,
      volume_1h_usd:         c.volumeUsd,
      status:                'watching',
      bonding_curve_pct:     bondingPct,
      holder_count:          holderCount,
      top_holder_pct:        topHolderPct,
      dev_wallet_pct:        devPct,
      velocity_pct_per_min:  velocitySolPerMin,
    }

    if (!existing) {
      upsertData.detected_at               = now
      upsertData.first_seen_at             = now
      upsertData.bonding_pct_at_first_seen = bondingPct
    }

    const { error } = await supabase
      .from('pre_grad_watchlist')
      .upsert(upsertData, { onConflict: 'mint', ignoreDuplicates: false })

    if (error) {
      console.error(`[pre-grad] upsert error for ${c.symbol}:`, error.message)
    } else if (!existing) {
      console.log(
        `[pre-grad] WATCHLIST ADD: ${c.symbol} (${c.mint.slice(0, 8)}...)` +
        ` curve=${bondingPct.toFixed(1)}% holders=${holderCount} dev=${devPct.toFixed(1)}%` +
        ` mcap=$${Math.round(c.marketCap).toLocaleString()}`
      )
      added++
    } else {
      console.log(
        `[pre-grad] UPDATE: ${c.symbol} curve=${bondingPct.toFixed(1)}%` +
        ` velocity=${velocitySolPerMin.toFixed(3)}pct/min`
      )
    }
  }

  return added
}

async function expireStale(): Promise<void> {
  const supabase = createServerClient()
  const cutoff = new Date(Date.now() - WATCH_HOURS * 3_600_000).toISOString()
  await supabase
    .from('pre_grad_watchlist')
    .update({ status: 'expired' })
    .eq('status', 'watching')
    .lt('detected_at', cutoff)
}

async function tick(): Promise<void> {
  console.log(`[pre-grad] poll — minMcap=$${MIN_MCAP.toLocaleString()} curve=${cfg.minBondingProgress}-${cfg.maxBondingProgress}% holders≥${cfg.minHolders} dev≤${cfg.maxDevWalletPct}%`)
  try {
    const candidates = await fetchActivePumpTokens()
    console.log(`[pre-grad] pump.fun returned ${candidates.length} active tokens`)
    if (candidates.length > 0) {
      const added = await upsertWatchlist(candidates)
      console.log(`[pre-grad] ${added} new tokens added to watchlist`)
    }
    await expireStale()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[pre-grad] tick error:', message)
  }
}

async function main(): Promise<void> {
  console.log(`[pre-grad] starting — poll every ${POLL_SEC}s, watch window ${WATCH_HOURS}h`)
  await tick()
  setInterval(tick, POLL_SEC * 1_000)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})
