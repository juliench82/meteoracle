/**
 * pre-grad-scanner.ts
 *
 * Polls Bitquery (REST v2) for pump.fun tokens nearing graduation (bonding curve
 * >= GRAD_THRESHOLD_PCT %) and stores them in pre_grad_watchlist.
 *
 * REQUIRED ENV VARS:
 *   BITQUERY_API_KEY  — Manual key from https://account.bitquery.io/user/api_v2_keys
 *                       Use "Manual" type (no 24h expiry).
 *
 * OPTIONAL ENV VARS:
 *   PRE_GRAD_THRESHOLD_PCT   — bonding curve % to trigger watchlist (default: 80)
 *   PRE_GRAD_POLL_INTERVAL_S — seconds between polls (default: 60)
 *   PRE_GRAD_WATCH_WINDOW_H  — hours to keep a token on watchlist (default: 6)
 *
 * Run on VPS:
 *   npx tsx bot/pre-grad-scanner.ts
 */

// Load .env.local (and .env) before anything else
import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'

const BITQUERY_URL   = 'https://streaming.bitquery.io/eap'
const API_KEY        = process.env.BITQUERY_API_KEY ?? ''
const THRESHOLD_PCT  = parseFloat(process.env.PRE_GRAD_THRESHOLD_PCT   ?? '80')
const POLL_SEC       = parseInt(process.env.PRE_GRAD_POLL_INTERVAL_S    ?? '60')
const WATCH_HOURS    = parseFloat(process.env.PRE_GRAD_WATCH_WINDOW_H   ?? '6')

if (!API_KEY) {
  console.error('[pre-grad] BITQUERY_API_KEY is not set — exiting')
  console.error('[pre-grad] Make sure it is in .env.local at the project root')
  process.exit(1)
}

const MOMENTUM_QUERY = `
query PumpMomentum($since: ISO8601DateTime!, $minTrades: Int!) {
  Solana {
    DEXTrades(
      where: {
        Trade: { Dex: { ProtocolFamily: { is: "pump" } } }
        Block: { Time: { since: $since } }
        Transaction: { Result: { Success: true } }
      }
      groupBy: [
        Trade_Buy_Currency_MintAddress
        Trade_Buy_Currency_Symbol
        Trade_Buy_Currency_Name
      ]
      orderBy: { descendingByField: "tradeCount" }
      limit: { count: 50 }
    ) {
      Trade {
        Buy {
          Currency {
            MintAddress
            Symbol
            Name
          }
          min_price: Price(minimum: Trade_Buy_Price)
          max_price: Price(maximum: Trade_Buy_Price)
        }
      }
      tradeCount: count
      volumeSol: sum(of: Trade_Buy_Amount)
    }
  }
}
`

interface BitqueryTrade {
  Trade: {
    Buy: {
      Currency: { MintAddress: string; Symbol: string; Name: string }
      min_price: number
      max_price: number
    }
  }
  tradeCount: number
  volumeSol: number
}

interface BitqueryResponse {
  data?: {
    Solana?: {
      DEXTrades?: BitqueryTrade[]
    }
  }
  errors?: Array<{ message: string }>
}

async function fetchPumpMomentum(lookbackMinutes: number): Promise<BitqueryTrade[]> {
  const since = new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString()
  const minTrades = 30

  const res = await axios.post<BitqueryResponse>(
    BITQUERY_URL,
    { query: MOMENTUM_QUERY, variables: { since, minTrades } },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': API_KEY,
      },
      timeout: 15_000,
    }
  )

  if (res.data.errors?.length) {
    throw new Error(res.data.errors.map(e => e.message).join('; '))
  }

  return res.data.data?.Solana?.DEXTrades ?? []
}

async function upsertWatchlist(trades: BitqueryTrade[]): Promise<number> {
  const supabase = createServerClient()
  let added = 0

  for (const t of trades) {
    const mint   = t.Trade.Buy.Currency.MintAddress
    const symbol = t.Trade.Buy.Currency.Symbol
    const name   = t.Trade.Buy.Currency.Name

    const { data: existing } = await supabase
      .from('pre_grad_watchlist')
      .select('id, status')
      .eq('mint', mint)
      .maybeSingle()

    if (existing && ['graduated', 'opened', 'expired'].includes(existing.status)) {
      continue
    }

    const { error } = await supabase
      .from('pre_grad_watchlist')
      .upsert({
        mint,
        symbol,
        name,
        volume_1h_usd: t.volumeSol,
        status: 'watching',
        detected_at: existing ? undefined : new Date().toISOString(),
      }, { onConflict: 'mint', ignoreDuplicates: false })

    if (error) {
      console.error(`[pre-grad] upsert error for ${symbol} (${mint.slice(0, 8)}):`, error.message)
    } else if (!existing) {
      console.log(`[pre-grad] WATCHLIST ADD: ${symbol} (${mint.slice(0, 8)}...) trades=${t.tradeCount} vol=${t.volumeSol.toFixed(2)} SOL`)
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
    const trades = await fetchPumpMomentum(5)
    console.log(`[pre-grad] Bitquery returned ${trades.length} active pump tokens`)

    if (trades.length > 0) {
      const added = await upsertWatchlist(trades)
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
