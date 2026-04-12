/**
 * spot-monitor.ts
 *
 * Polls every 30s for all open spot positions.
 * Price source priority:
 *   1. Jupiter Price API v2 (post-grad / DEX-listed tokens)
 *   2. pump.fun API fallback (pre-grad tokens still on bonding curve)
 *
 * BOT_DRY_RUN=true  — real prices, no actual sell tx
 * BOT_DRY_RUN=false — real prices + real sell tx
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

console.log(`[spot-monitor] starting — DRY_RUN=${DRY_RUN}`)
console.log(`[spot-monitor] TP=+${cfg.exits.takeProfitPct}% | SL=${cfg.exits.stopLossPct}% | maxHold=${cfg.exits.maxHoldMinutes}min`)
console.log(`[spot-monitor] poll interval: ${POLL_INTERVAL / 1000}s`)

interface SpotPosition {
  id:              string
  mint:            string
  symbol:          string
  name:            string
  entry_price_sol: number
  entry_price_usd: number
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

/** Try Jupiter first, fall back to pump.fun for pre-grad tokens */
async function fetchPriceUsd(mint: string): Promise<number | null> {
  // 1. Jupiter
  try {
    const res = await axios.get('https://api.jup.ag/price/v2', {
      params: { ids: mint },
      timeout: 8_000,
    })
    const price = res.data?.data?.[mint]?.price
    if (price) return parseFloat(price)
  } catch {
    // fall through
  }

  // 2. pump.fun fallback
  try {
    const res = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      timeout: 8_000,
      headers: { 'User-Agent': 'meteoracle-monitor/1.0' },
    })
    const usdMc   = parseFloat(res.data?.usd_market_cap ?? '0')
    const supply  = parseFloat(res.data?.total_supply    ?? '0')
    if (usdMc > 0 && supply > 0) {
      const price = usdMc / supply
      return price
    }
  } catch {
    // fall through
  }

  return null
}

function checkExitCondition(
  position:       SpotPosition,
  pricePctChange: number,
  ageMinutes:     number,
): ExitReason | null {
  if (pricePctChange >= position.tp_pct)             return 'tp'
  if (pricePctChange <= -Math.abs(position.sl_pct))  return 'sl'
  if (ageMinutes     >= cfg.exits.maxHoldMinutes)    return 'timeout'
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
  } else {
    solReceived = position.amount_sol * exitMult
    pnlSol      = solReceived - position.amount_sol
    console.log(`[spot-monitor] DRY-RUN close — ${solReceived.toFixed(4)} SOL simulated`)
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

  const emoji    = reason === 'tp' ? '🟢' : reason === 'sl' ? '🔴' : '⏱️'
  const pnlStr   = `${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL`
  const pctStr   = `${((exitMult - 1) * 100).toFixed(1)}%`
  const dryLabel = position.dry_run ? '[DRY-RUN] ' : ''
  const txLine   = txSell ? `\n🔗 https://solscan.io/tx/${txSell}` : ''

  console.log(`${emoji} [spot-monitor] CLOSED ${label} reason=${reason} pnl=${pnlStr}`)

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
    const ageMinutes = (Date.now() - new Date(pos.opened_at).getTime()) / 60_000

    const currentPriceUsd = await fetchPriceUsd(pos.mint)
    if (currentPriceUsd === null) {
      console.warn(`[spot-monitor] price unavailable for ${label} — skipping`)
      continue
    }

    let priceMultiplier: number
    let pricePctChange: number

    if (!pos.entry_price_usd || pos.entry_price_usd === 0) {
      // Seed entry price on first successful fetch
      priceMultiplier = 1.0
      pricePctChange  = 0
      await supabase
        .from('spot_positions')
        .update({ entry_price_usd: currentPriceUsd })
        .eq('id', pos.id)
      console.log(`[spot-monitor] ${label} seeded entry_price_usd=$${currentPriceUsd.toExponential(4)}`)
    } else {
      priceMultiplier = currentPriceUsd / pos.entry_price_usd
      pricePctChange  = (priceMultiplier - 1) * 100
    }

    console.log(
      `[spot-monitor] ${label}` +
      ` price=$${currentPriceUsd.toExponential(4)}` +
      ` (${pricePctChange >= 0 ? '+' : ''}${pricePctChange.toFixed(1)}%)` +
      ` age=${ageMinutes.toFixed(1)}min`
    )

    const exitReason = checkExitCondition(pos, pricePctChange, ageMinutes)
    if (exitReason) {
      const pnlSol = pos.amount_sol * (priceMultiplier - 1)
      await closePosition(pos, exitReason, pnlSol, priceMultiplier)
      closed++
    }
  }

  return { monitored: positions.length, closed }
}

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
