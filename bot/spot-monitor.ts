/**
 * spot-monitor.ts  —  Day 4
 *
 * Polls every 30s for all open spot positions.
 * For each position:
 *   1. Fetches current price from Jupiter Price API v2
 *   2. Checks TP / SL / maxHold conditions
 *   3. If triggered: calls spot-seller.ts, updates spot_positions row
 *
 * DRY_RUN mode: simulates price move using a random walk so you can
 * watch the full TP/SL cycle without real money.
 *
 * BOT_DRY_RUN=true  (default) — no real sells, price is simulated
 * BOT_DRY_RUN=false           — live sells via Jupiter
 *
 * Run:
 *   npx tsx bot/spot-monitor.ts
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { sellTokenForSol } from './spot-seller'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'

const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const POLL_INTERVAL = parseInt(process.env.SPOT_MONITOR_POLL_SEC ?? '30') * 1_000
const cfg           = PRE_GRAD_STRATEGY

// In dry-run we simulate price with a random walk so exits can be tested.
// Maps mint -> simulated price multiplier (starts at 1.0)
const dryRunPriceMultiplier = new Map<string, number>()

console.log(`[spot-monitor] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[spot-monitor] TP=+${cfg.exits.takeProfitPct}% | SL=${cfg.exits.stopLossPct}% | maxHold=${cfg.exits.maxHoldMinutes}min`)
console.log(`[spot-monitor] poll interval: ${POLL_INTERVAL / 1000}s`)

// ---- Types ----

interface SpotPosition {
  id:              string
  mint:            string
  symbol:          string
  name:            string
  entry_price_sol: number
  amount_sol:      number
  token_amount:    number
  tp_pct:          number
  sl_pct:          number
  status:          string
  dry_run:         boolean
  opened_at:       string
  tx_buy:          string | null
}

type ExitReason = 'tp' | 'sl' | 'timeout'

// ---- Price fetching ----

/**
 * Jupiter Price API v2 — returns price of token in USDC.
 * We use it as a proxy: price change % is what matters, not absolute USD value.
 * For SOL-denominated P&L we convert: currentPriceSol = entryPriceSol * (currentUsd / entryUsd)
 * But since we stored entry_price_sol=0 for dry-run, we track multiplier instead.
 */
async function fetchPriceUsd(mint: string): Promise<number | null> {
  try {
    const res = await axios.get('https://api.jup.ag/price/v2', {
      params: { ids: mint },
      timeout: 8_000,
    })
    const price = res.data?.data?.[mint]?.price
    return price ? parseFloat(price) : null
  } catch {
    return null
  }
}

// ---- Dry-run price simulation ----
// Simulates a price random walk so TP/SL exits fire during testing.
// Each tick: +/-15% move with slight upward bias to hit TP occasionally.
function simulatePrice(mint: string): number {
  const prev = dryRunPriceMultiplier.get(mint) ?? 1.0
  // Random walk: -15% to +20% per tick
  const delta = (Math.random() * 0.35) - 0.15
  const next  = Math.max(0.01, prev * (1 + delta))
  dryRunPriceMultiplier.set(mint, next)
  return next  // multiplier relative to entry (1.0 = no change)
}

// ---- Exit logic ----

function checkExitCondition(
  position:      SpotPosition,
  pricePctChange: number,
  ageMinutes:    number,
): ExitReason | null {
  const tp = position.tp_pct           // e.g. 200  (means +200%)
  const sl = position.sl_pct           // e.g. -40  (means -40%)
  const maxHold = cfg.exits.maxHoldMinutes

  if (pricePctChange >= tp)   return 'tp'
  if (pricePctChange <= sl)   return 'sl'
  if (ageMinutes >= maxHold)  return 'timeout'
  return null
}

async function closePosition(
  position:   SpotPosition,
  reason:     ExitReason,
  pnlSol:     number,
  exitMult:   number,   // price multiplier at exit vs entry
): Promise<void> {
  const supabase = createServerClient()
  const label    = `${position.symbol} (${position.mint.slice(0, 8)}...)`

  console.log(
    `[spot-monitor] EXIT ${reason.toUpperCase()} — ${label}` +
    ` pnl=${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL` +
    ` (${((exitMult - 1) * 100).toFixed(1)}% price move)`
  )

  let txSell: string | undefined
  let solReceived = 0

  if (!position.dry_run && position.token_amount > 0) {
    // Live sell — pump.fun tokens are always 6 decimals
    const sellResult = await sellTokenForSol(
      position.mint,
      position.token_amount,
      6,
      position.symbol,
    )
    if (!sellResult.success) {
      console.error(`[spot-monitor] sell failed for ${label}: ${sellResult.error}`)
      return  // Don't close DB row if sell failed — will retry next tick
    }
    txSell      = sellResult.txSignature
    solReceived = sellResult.solReceived ?? 0
    pnlSol      = solReceived - position.amount_sol
  } else if (position.dry_run) {
    // Dry-run: simulate SOL received
    solReceived = position.amount_sol * exitMult
    pnlSol      = solReceived - position.amount_sol
    console.log(`[spot-monitor] DRY-RUN sell — simulated ${solReceived.toFixed(4)} SOL received`)
  }

  const statusMap: Record<ExitReason, string> = {
    tp:      'closed_tp',
    sl:      'closed_sl',
    timeout: 'closed_sl',  // timeout treated as SL (didn't hit TP in time)
  }

  const { error } = await supabase
    .from('spot_positions')
    .update({
      status:         statusMap[reason],
      closed_at:      new Date().toISOString(),
      exit_price_sol: position.entry_price_sol * exitMult,
      pnl_sol:        pnlSol,
      tx_sell:        txSell ?? null,
    })
    .eq('id', position.id)

  if (error) {
    console.error(`[spot-monitor] DB update failed for ${label}:`, error.message)
  } else {
    const emoji = reason === 'tp' ? '🟢' : reason === 'sl' ? '🔴' : '⏱️'
    console.log(
      `${emoji} [spot-monitor] CLOSED ${label}` +
      ` reason=${reason} pnl=${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`
    )
  }
}

// ---- Main poll tick ----

async function tick(): Promise<void> {
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('spot_positions')
    .select('*')
    .eq('status', 'open')

  if (error) {
    console.error('[spot-monitor] fetch error:', error.message)
    return
  }

  const positions = (data ?? []) as SpotPosition[]
  if (positions.length === 0) {
    console.log('[spot-monitor] no open positions')
    return
  }

  console.log(`[spot-monitor] monitoring ${positions.length} open position(s)`)

  for (const pos of positions) {
    const label      = `${pos.symbol} (${pos.mint.slice(0, 8)}...)`
    const openedAt   = new Date(pos.opened_at).getTime()
    const ageMinutes = (Date.now() - openedAt) / 60_000

    let pricePctChange: number
    let priceMultiplier: number

    if (pos.dry_run) {
      // Simulate price move for dry-run testing
      priceMultiplier = simulatePrice(pos.mint)
      pricePctChange  = (priceMultiplier - 1) * 100
      console.log(
        `[spot-monitor] ${label}` +
        ` sim_price=${priceMultiplier.toFixed(3)}x` +
        ` (${pricePctChange >= 0 ? '+' : ''}${pricePctChange.toFixed(1)}%)` +
        ` age=${ageMinutes.toFixed(1)}min`
      )
    } else {
      // Live: fetch real price from Jupiter
      const currentPrice = await fetchPriceUsd(pos.mint)
      if (currentPrice === null) {
        console.warn(`[spot-monitor] could not fetch price for ${label} — skipping`)
        continue
      }
      // entry_price_sol is in SOL; we compare % change only
      // If entry_price_sol is 0 (edge case), skip
      if (!pos.entry_price_sol || pos.entry_price_sol === 0) {
        console.warn(`[spot-monitor] entry_price_sol=0 for ${label} — skipping`)
        continue
      }
      // We stored entry in SOL; Jupiter gives USD. We track % change, not abs value.
      // Workaround: store USD price at entry in metadata. For now, flag for manual review.
      console.warn(
        `[spot-monitor] LIVE mode: entry_price_sol=${pos.entry_price_sol}` +
        ` currentUsd=${currentPrice} — need USD entry price for accurate % calc.
        Consider storing entry_price_usd at buy time.`
      )
      priceMultiplier = 1   // placeholder: no exit until entry_price_usd is stored
      pricePctChange  = 0
    }

    const exitReason = checkExitCondition(pos, pricePctChange, ageMinutes)
    if (exitReason) {
      const pnlSol = pos.amount_sol * (priceMultiplier - 1)
      await closePosition(pos, exitReason, pnlSol, priceMultiplier)
    }
  }
}

async function main(): Promise<void> {
  await tick()
  setInterval(tick, POLL_INTERVAL)
}

main().catch(err => {
  console.error('[spot-monitor] fatal:', err)
  process.exit(1)
})
