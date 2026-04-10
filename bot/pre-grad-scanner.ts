/**
 * pre-grad-scanner.ts
 *
 * Polls Bitquery EAP (v2) for active pump.fun tokens using the Trading.Pairs API
 * and stores them in pre_grad_watchlist so spot-buyer.ts can act on them.
 *
 * REQUIRED ENV VARS:
 *   BITQUERY_API_KEY  — Manual key from https://account.bitquery.io/user/api_v2_keys
 *
 * OPTIONAL ENV VARS:
 *   PRE_GRAD_POLL_INTERVAL_S — seconds between polls (default: 60)
 *   PRE_GRAD_WATCH_WINDOW_H  — hours to keep a token on watchlist (default: 6)
 *   PRE_GRAD_MIN_MCAP        — min market cap USD to include (default: 50000)
 *
 * Run:
 *   npx tsx bot/pre-grad-scanner.ts
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'

const BITQUERY_URL  = 'https://streaming.bitquery.io/eap'
const API_KEY       = process.env.BITQUERY_API_KEY ?? ''
const POLL_SEC      = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S ?? '60')
const WATCH_HOURS   = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H ?? '6')
// Min market cap in USD — pump.fun graduates at ~$69k, so 50k catches near-grad tokens
const MIN_MCAP      = parseFloat(process.env.PRE_GRAD_MIN_MCAP ?? '50000')

if (!API_KEY) {
  console.error('[pre-grad] BITQUERY_API_KEY is not set — exiting')
  process.exit(1)
}

// Uses Trading.Pairs API (correct for EAP v2) — finds pump.fun tokens
// traded in last 5 minutes, filtered by min market cap, ordered by market cap desc.
// This is the pattern from official Bitquery pump.fun docs.
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
      Token {
        Address
        Name
        Symbol
      }
      Market {
        Address
        Program
      }
      Supply {
        MarketCap
      }
      Volume {
        Usd
      }
    }
  }
}
`

interface PairResult {
  Token: { Address: string; Name: string; Symbol: string }
  Market: { Address: string; Program: string }
  Supply: { MarketCap: number }
  Volume: { Usd: number }
}

interface PairsResponse {
  data?: { Trading?: { Pairs?: PairResult[] } }
  errors?: Array<{ message: string }>
}

interface Candidate {
  mint: string
  symbol: string
  name: string
  marketCap: number
  volumeUsd: number
}

async function fetchActivePumpPairs(): Promise<Candidate[]> {
  const res = await axios.post<PairsResponse>(
    BITQUERY_URL,
    { query: PUMP_PAIRS_QUERY, variables: { minMcap: MIN_MCAP } },
    {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      timeout: 15_000,
    }
  )

  if (res.data.errors?.length) {
    throw new Error(res.data.errors.map(e => e.message).join('; '))
  }

  const pairs = res.data.data?.Trading?.Pairs ?? []

  return pairs
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
      .select('id, status')
      .eq('mint', c.mint)
      .maybeSingle()

    if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) continue

    const { error } = await supabase
      .from('pre_grad_watchlist')
      .upsert({
        mint:          c.mint,
        symbol:        c.symbol,
        name:          c.name,
        volume_1h_usd: c.volumeUsd,
        status:        'watching',
        detected_at:   existing ? undefined : new Date().toISOString(),
      }, { onConflict: 'mint', ignoreDuplicates: false })

    if (error) {
      console.error(`[pre-grad] upsert error for ${c.symbol}:`, error.message)
    } else if (!existing) {
      console.log(
        `[pre-grad] WATCHLIST ADD: ${c.symbol} (${c.mint.slice(0, 8)}...)` +
        ` mcap=$${Math.round(c.marketCap).toLocaleString()} vol=$${Math.round(c.volumeUsd).toLocaleString()}`
      )
      added++
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
  console.log(`[pre-grad] poll — minMcap=$${MIN_MCAP.toLocaleString()} window=5min`)
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
  console.log(`[pre-grad] Bitquery EAP endpoint: ${BITQUERY_URL}`)
  await tick()
  setInterval(tick, POLL_SEC * 1_000)
}

main().catch(err => {
  console.error('[pre-grad] fatal:', err)
  process.exit(1)
})
