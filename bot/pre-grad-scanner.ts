/**
 * pre-grad-scanner.ts
 *
 * Polls Bitquery EAP (v2) for active pump.fun tokens.
 * For each candidate, enriches with pump.fun API data:
 *   - bonding_curve_pct (88-98% window)
 *   - dev_wallet_pct    (≤ 3%)
 *   - holder_count      (≥ 100)
 *   - top_holder_pct    (≤ 12%)
 *
 * Velocity tracking: stores first_seen_at + bonding_pct_at_first_seen
 * to derive curve progress rate (SOL/min) across polls.
 * Filters out tokens that crawled to 88% over many hours.
 *
 * REQUIRED ENV VARS:
 *   BITQUERY_API_KEY  — https://account.bitquery.io/user/api_v2_keys
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

const BITQUERY_URL  = 'https://streaming.bitquery.io/eap'
const PUMP_API      = 'https://frontend-api.pump.fun/coins'
const API_KEY       = process.env.BITQUERY_API_KEY ?? ''
const POLL_SEC      = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S ?? '60')
const WATCH_HOURS   = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
const MIN_MCAP      = parseFloat(process.env.PRE_GRAD_MIN_MCAP ?? '50000')
const cfg           = PRE_GRAD_STRATEGY.scanner

if (!API_KEY) {
  console.error('[pre-grad] BITQUERY_API_KEY is not set — exiting')
  process.exit(1)
}

const PUMP_PAIRS_QUERY = `
query PumpActivePairs($minMcap: Float!) {
  Trading {
    Pairs(
      limitBy: { by: Token_Address, count: 1 }
      limit: { count: 50 }
      orderBy: { descendingByField: "Supply_MarketCap" }
      where: {
        Market: { Program: { is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" } }
        Token: { Network: { is: "Solana" } }
        Supply: { MarketCap: { ge: $minMcap } }
        Block: { Time: { since_relative: { minutes_ago: 5 } } }
        Interval: { Time: { Duration: { eq: 1 } } }
      }
    ) {
      Token { Address Name Symbol }
      Market { Address Program }
      Supply { MarketCap }
      Volume { Usd }
    }
  }
}
`

interface PairResult {
  Token:   { Address: string; Name: string; Symbol: string }
  Market:  { Address: string; Program: string }
  Supply:  { MarketCap: number }
  Volume:  { Usd: number }
}

interface PairsResponse {
  data?:   { Trading?: { Pairs?: PairResult[] } }
  errors?: Array<{ message: string }>
}

interface Candidate {
  mint:      string
  symbol:    string
  name:      string
  marketCap: number
  volumeUsd: number
}

interface PumpCoin {
  complete:            boolean
  bonding_curve_pct?:  number
  king_of_the_hill?:   number
  total_supply?:       number
  virtual_sol_reserves?: number
  virtual_token_reserves?: number
  creator?:            string
  top_holders?:        Array<{ wallet: string; pct: number }>
  holder_count?:       number
  top_holder_pct?:     number
  reply_count?:        number
  last_reply?:         string
  created_timestamp?:  number
}

async function fetchPumpCoin(mint: string): Promise<PumpCoin | null> {
  try {
    const res = await axios.get<PumpCoin>(`${PUMP_API}/${mint}`, { timeout: 6_000 })
    return res.data ?? null
  } catch {
    return null
  }
}

// Derive dev wallet % from pump.fun top_holders if available,
// or fallback to checking if creator is in top holders.
function getDevWalletPct(coin: PumpCoin): number {
  if (!coin.creator) return 0
  if (coin.top_holders && coin.top_holders.length > 0) {
    const devEntry = coin.top_holders.find(h => h.wallet === coin.creator)
    return devEntry?.pct ?? 0
  }
  // No holder breakdown available — can't filter, assume ok
  return 0
}

async function fetchActivePumpPairs(): Promise<Candidate[]> {
  const res = await axios.post<PairsResponse>(
    BITQUERY_URL,
    { query: PUMP_PAIRS_QUERY, variables: { minMcap: MIN_MCAP } },
    {
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      timeout: 15_000,
    }
  )

  if (res.data.errors?.length) {
    throw new Error(res.data.errors.map(e => e.message).join('; '))
  }

  return (res.data.data?.Trading?.Pairs ?? [])
    .filter(p => p.Token.Address && p.Token.Symbol)
    .map(p => ({
      mint:      p.Token.Address,
      symbol:    p.Token.Symbol,
      name:      p.Token.Name ?? '',
      marketCap: p.Supply?.MarketCap ?? 0,
      volumeUsd: p.Volume?.Usd ?? 0,
    }))
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

    // ── Enrich with pump.fun data ──────────────────────────────────────────
    const coin = await fetchPumpCoin(c.mint)
    if (!coin) {
      console.log(`[pre-grad] ${c.symbol} — skip: pump.fun API unavailable`)
      continue
    }

    // Already graduated
    if (coin.complete) {
      console.log(`[pre-grad] ${c.symbol} — skip: already graduated`)
      continue
    }

    const bondingPct   = coin.bonding_curve_pct ?? 0
    const holderCount  = coin.holder_count ?? 0
    const topHolderPct = coin.top_holder_pct ?? 0
    const devPct       = getDevWalletPct(coin)

    // ── Filter: bonding curve window ───────────────────────────────────────
    if (bondingPct < cfg.minBondingProgress) {
      console.log(`[pre-grad] ${c.symbol} — skip: curve ${bondingPct.toFixed(1)}% < ${cfg.minBondingProgress}%`)
      continue
    }
    if (bondingPct > cfg.maxBondingProgress) {
      console.log(`[pre-grad] ${c.symbol} — skip: curve ${bondingPct.toFixed(1)}% > ${cfg.maxBondingProgress}% (near/post-grad)`)
      continue
    }

    // ── Filter: holders ───────────────────────────────────────────────────
    if (holderCount > 0 && holderCount < cfg.minHolders) {
      console.log(`[pre-grad] ${c.symbol} — skip: holders ${holderCount} < ${cfg.minHolders}`)
      continue
    }

    // ── Filter: top holder concentration ──────────────────────────────────
    if (topHolderPct > 0 && topHolderPct > cfg.maxTopHolderPct) {
      console.log(`[pre-grad] ${c.symbol} — skip: top holder ${topHolderPct.toFixed(1)}% > ${cfg.maxTopHolderPct}%`)
      continue
    }

    // ── Filter: dev wallet ────────────────────────────────────────────────
    if (devPct > cfg.maxDevWalletPct) {
      console.log(`[pre-grad] ${c.symbol} — skip: dev wallet ${devPct.toFixed(1)}% > ${cfg.maxDevWalletPct}%`)
      continue
    }

    // ── Velocity: compute curve progress rate ─────────────────────────────
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

    // ── Upsert ────────────────────────────────────────────────────────────
    const upsertData: Record<string, unknown> = {
      mint:                     c.mint,
      symbol:                   c.symbol,
      name:                     c.name,
      volume_1h_usd:            c.volumeUsd,
      status:                   'watching',
      bonding_curve_pct:        bondingPct,
      holder_count:             holderCount,
      top_holder_pct:           topHolderPct,
      dev_wallet_pct:           devPct,
      velocity_pct_per_min:     velocitySolPerMin,
    }

    if (!existing) {
      upsertData.detected_at             = now
      upsertData.first_seen_at           = now
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
        ` mcap=$${Math.round(c.marketCap).toLocaleString()} vol=$${Math.round(c.volumeUsd).toLocaleString()}`
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
  console.log(`[pre-grad] poll — minMcap=$${MIN_MCAP.toLocaleString()} curve=${cfg.minBondingProgress}-${cfg.maxBondingProgress}% vol≥${cfg.minVolume5minSol}SOL dev≤${cfg.maxDevWalletPct}%`)
  try {
    const candidates = await fetchActivePumpPairs()
    console.log(`[pre-grad] Bitquery returned ${candidates.length} active pump tokens`)
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
