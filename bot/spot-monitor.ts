/**
 * spot-monitor.ts  — Day 4 + Day 5
 *
 * Polls every 30s for all open spot positions.
 * For each position:
 *   1. Fetches current price from Jupiter Price API v2
 *   2. Checks TP / SL / maxHold conditions
 *   3. If triggered: calls spot-seller.ts, updates spot_positions row
 *   4. Sends Telegram alert on close
 *
 * DRY_RUN: simulates price random walk so you can watch full TP/SL cycle.
 * LIVE: uses entry_price_usd (stored at buy time) for accurate % change.
 *
 * BOT_DRY_RUN=true  (default)
 * BOT_DRY_RUN=false
 */

import 'dotenv/config'
import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: true })

import axios from 'axios'
import { createServerClient } from '@/lib/supabase'
import { sellTokenForSol } from './spot-seller'
import { PRE_GRAD_STRATEGY } from '../strategies/pre-grad'
import { sendTelegram } from './telegram'

const DRY_RUN       = process.env.BOT_DRY_RUN !== 'false'
const POLL_INTERVAL = parseInt(process.env.SPOT_MONITOR_POLL_SEC ?? '30') * 1_000
const cfg           = PRE_GRAD_STRATEGY

const dryRunPriceMultiplier = new Map<string, number>()

console.log(`[spot-monitor] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[spot-monitor] TP=+${cfg.exits.takeProfitPct}% | SL=${cfg.exits.stopLossPct}% | maxHold=${cfg.exits.maxHoldMinutes}min`)
console.log(`[spot-monitor] poll interval: ${POLL_INTERVAL / 1000}s`)

interface SpotPosition {
  id:              string
  mint:            string
  symbol:          string
  name:            string
  entry_price_sol: number
  entry_price_usd: number   // stored at buy time (Day 5)
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

function simulatePrice(mint: string): number {
  const prev  = dryRunPriceMultiplier.get(mint) ?? 1.0
  const delta = (Math.random() * 0.35) - 0.15
  const next  = Math.max(0.01, prev * (1 + delta))
  dryRunPriceMultiplier.set(mint, next)
  return next
}

function checkExitCondition(
  position:       SpotPosition,
  pricePctChange: number,
  ageMinutes:     number,
): ExitReason | null {
  if (pricePctChange >= position.tp_pct)          return 'tp'
  if (pricePctChange <= position.sl_pct)          return 'sl'
  if (ageMinutes     >= cfg.exits.maxHoldMinutes) return 'timeout'
  return null
}

async function closePosition(
  position:   SpotPosition,
  reason:     ExitReason,
  pnlSol:     number,
  exitMult:   number,
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
    const sellResult = await sellTokenForSol(
      position.mint,
      position.token_amount,
      6,
      position.symbol,
    )
    if (!sellResult.success) {
      console.error(`[spot-monitor] sell failed for ${label}: ${sellResult.error}`)
      return
    }
    txSell      = sellResult.txSignature
    solReceived = sellResult.solReceived ?? 0
    pnlSol      = solReceived - position.amount_sol
  } else if (position.dry_run) {
    solReceived = position.amount_sol * exitMult
    pnlSol      = solReceived - position.amount_sol
    console.log(`[spot-monitor] DRY-RUN sell — simulated ${solReceived.toFixed(4)} SOL received`)
  }

  const statusMap: Record<ExitReason, string> = {
    tp:      'closed_tp',
    sl:      'closed_sl',
    timeout: 'closed_sl',
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
    return
  }

  const emoji      = reason === 'tp' ? '🟢' : reason === 'sl' ? '🔴' : '⏱️'
  const pnlStr     = `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`
  const pctStr     = `${((exitMult - 1) * 100).toFixed(1)}%`
  const dryLabel   = position.dry_run ? '[DRY-RUN] ' : ''

  console.log(`${emoji} [spot-monitor] CLOSED ${label} reason=${reason} pnl=${pnlStr}`)

  const txLine = txSell
    ? `\n🔗 https://solscan.io/tx/${txSell}`
    : ''

  await sendTelegram(
    `${emoji} ${dryLabel}CLOSED ${position.symbol}\n` +
    `📉 Reason: ${reason.toUpperCase()} (${pctStr})\n` +
    `💰 PnL: ${pnlStr}${txLine}`
  )
}

async function tick(): Promise<{ monitored: number; closed: number }> {
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('spot_positions')
    .select('*')
    .eq('status', 'open')

  if (error) {
    console.error('[spot-monitor] fetch error:', error.message)
    return { monitored: 0, closed: 0 }
  }

  const positions = (data ?? []) as SpotPosition[]
  if (positions.length === 0) {
    console.log('[spot-monitor] no open positions')
    return { monitored: 0, closed: 0 }
  }

  console.log(`[spot-monitor] monitoring ${positions.length} open position(s)`)
  let closed = 0

  for (const pos of positions) {
    const label      = `${pos.symbol} (${pos.mint.slice(0, 8)}...)`
    const openedAt   = new Date(pos.opened_at).getTime()
    const ageMinutes = (Date.now() - openedAt) / 60_000

    let pricePctChange: number
    let priceMultiplier: number

    if (pos.dry_run) {
      priceMultiplier = simulatePrice(pos.mint)
      pricePctChange  = (priceMultiplier - 1) * 100
      console.log(
        `[spot-monitor] ${label}` +
        ` sim_price=${priceMultiplier.toFixed(3)}x` +
        ` (${pricePctChange >= 0 ? '+' : ''}${pricePctChange.toFixed(1)}%)` +
        ` age=${ageMinutes.toFixed(1)}min`
      )
    } else {
      // Live: use entry_price_usd for accurate % change
      const currentPriceUsd = await fetchPriceUsd(pos.mint)
      if (currentPriceUsd === null) {
        console.warn(`[spot-monitor] could not fetch price for ${label} — skipping`)
        continue
      }
      if (!pos.entry_price_usd || pos.entry_price_usd === 0) {
        console.warn(`[spot-monitor] entry_price_usd=0 for ${label} — skipping (stale row)`)
        continue
      }
      priceMultiplier = currentPriceUsd / pos.entry_price_usd
      pricePctChange  = (priceMultiplier - 1) * 100
      console.log(
        `[spot-monitor] ${label}` +
        ` price=$${currentPriceUsd.toExponential(4)}` +
        ` (${pricePctChange >= 0 ? '+' : ''}${pricePctChange.toFixed(1)}%)` +
        ` age=${ageMinutes.toFixed(1)}min`
      )
    }

    const exitReason = checkExitCondition(pos, pricePctChange, ageMinutes)
    if (exitReason) {
      const pnlSol = pos.amount_sol * (priceMultiplier - 1)
      await closePosition(pos, exitReason, pnlSol, priceMultiplier)
      closed++
    }
  }

  return { monitored: positions.length, closed }
}

/**
 * Exported tick for use by telegram-bot /tick command.
 * Returns a summary string for reporting.
 */
export async function runSpotMonitor(): Promise<string> {
  try {
    const before = Date.now()
    const result = await tick()
    return `✅ spot-monitor: ${result.monitored} monitored, ${result.closed} closed (${Date.now() - before}ms)`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `❌ spot-monitor: ${msg}`
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
