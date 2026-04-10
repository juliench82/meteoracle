/**
 * pre-grad-scanner.ts
 *
 * Polls Bitquery EAP (v2) for active pump.fun tokens and stores them
 * in pre_grad_watchlist so spot-buyer.ts can act on them.
 *
 * REQUIRED ENV VARS:
 *   BITQUERY_API_KEY  — Manual key from https://account.bitquery.io/user/api_v2_keys
 *
 * OPTIONAL ENV VARS:
 *   PRE_GRAD_THRESHOLD_PCT   — (default: 80)
 *   PRE_GRAD_POLL_INTERVAL_S — (default: 60)
 *   PRE_GRAD_WATCH_WINDOW_H  — (default: 6)
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
const THRESHOLD_PCT = parseFloat(process.env.PRE_GRAD_THRESHOLD_PCT   ?? '80')
const POLL_SEC      = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S    ?? '60')
const WATCH_HOURS   = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H   ?? '6')

if (!API_KEY) {
  console.error('[pre-grad] BITQUERY_API_KEY is not set — exiting')
  process.exit(1)
}

// EAP v2 schema:
// - DateTime (not ISO8601DateTime)
// - No top-level groupBy; aggregation uses limitBy
// - Count/sum aliases work differently
// Strategy: fetch the top 50 most-traded pump.fun tokens in the last N minutes,
// ordered by trade count descending. High trade count = momentum = near-grad candidate.
const MOMENTUM_QUERY = `
query PumpMomentum($since: DateTime!) {
  Solana {
    DEXTrades(
      where: {
        Trade: { Dex: { ProtocolFamily: { is: "pump" } } }
        Block: { Time: { after: $since } }
        Transaction: { Result: { Success: true } }
      }
      orderBy: { descendingByField: "count" }
      limit: { count: 50 }
      limitBy: { by: Trade_Buy_Currency_MintAddress, count: 1 }
    ) {
      count
      Trade {
        Buy {
          Currency {
            MintAddress
            Symbol
            Name
          }
          Amount
        }
      }
    }
  }
}
`

interface EAPTrade {
  count: number
  Trade: {
    Buy: {
      Currency: { MintAddress: string; Symbol: string; Name: string }
      Amount: number
    }
  }
}

interface EAPResponse {
  data?: { Solana?: { DEXTrades?: EAPTrade[] } }
  errors?: Array<{ message: string }>
}

interface Candidate {
  mint: string
  symbol: string
  name: string
  tradeCount: number
  volumeSol: number
}

async function fetchPumpMomentum(lookbackMinutes: number): Promise<Candidate[]> {
  // EAP DateTime format: "2026-04-10T10:00:00Z"
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  const res = await axios.post<EAPResponse>(
    BITQUERY_URL,
    { query: MOMENTUM_QUERY, variables: { since } },
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

  const trades = res.data.data?.Solana?.DEXTrades ?? []

  return trades.map(t => ({
    mint:       t.Trade.Buy.Currency.MintAddress,
    symbol:     t.Trade.Buy.Currency.Symbol || 'UNKNOWN',
    name:       t.Trade.Buy.Currency.Name   || '',
    tradeCount: t.count,
    volumeSol:  t.Trade.Buy.Amount ?? 0,
  }))
}

async function upsertWatchlist(candidates: Candidate[]): Promise<number> {
  const supabase = createServerClient()
  let added = 0

  for (const c of candidates) {
    // Skip tokens with no real symbol
    if (!c.mint || c.symbol === 'UNKNOWN') continue

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
        volume_1h_usd: c.volumeSol,
        status:        'watching',
        detected_at:   existing ? undefined : new Date().toISOString(),
      }, { onConflict: 'mint', ignoreDuplicates: false })

    if (error) {
      console.error(`[pre-grad] upsert error for ${c.symbol}:`, error.message)
    } else if (!existing) {
      console.log(
        `[pre-grad] WATCHLIST ADD: ${c.symbol} (${c.mint.slice(0, 8)}...)` +
        ` trades=${c.tradeCount} vol=${c.volumeSol.toFixed(2)} SOL`
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
  console.log(`[pre-grad] poll — threshold=${THRESHOLD_PCT}% window=5min`)
  try {
    const candidates = await fetchPumpMomentum(5)
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
