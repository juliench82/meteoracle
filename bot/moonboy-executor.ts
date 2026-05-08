import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { getConnection, getWallet } from '@/lib/solana'
import { createServerClient } from '@/lib/supabase'
import { buyTokenWithSol, swapTokenToSol } from '@/lib/swap'
import { sendAlert } from '@/bot/alerter'
import type { TokenMetrics } from '@/lib/types'
import { moonboyStrategy } from '@/strategies/moonboy'

const MOONBOY_BUY_USD = parseFloat(process.env.MOONBOY_BUY_USD ?? '10')
const MOONBOY_MAX_OPEN = parseInt(process.env.MOONBOY_MAX_OPEN ?? '3')
const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2'
const NATIVE_MINT = 'So11111111111111111111111111111111111111112'

type MoonboyRow = {
  id: string
  mint: string
  symbol: string
  entry_price_usd: number
  token_amount: string
  sol_spent: number
  status: string
  opened_at: string
  strategy_id: string
  dry_run: boolean
  sol_price_usd: number
}

async function countOpenMoonboys(supabase: ReturnType<typeof createServerClient>): Promise<number> {
  const { count } = await supabase
    .from('moonboy_positions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
  return count ?? 0
}

async function getTokenPriceUsd(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const price = data?.data?.[mint]?.price
    return typeof price === 'number' && price > 0 ? price : null
  } catch {
    return null
  }
}

export async function openMoonboyPosition(metrics: TokenMetrics, solPriceUsd: number): Promise<string | null> {
  const label = `[moonboy][${metrics.symbol}]`
  const supabase = createServerClient()

  if (!moonboyStrategy.enabled) {
    console.log(`${label} moonboy strategy disabled`)
    return null
  }

  const openCount = await countOpenMoonboys(supabase)
  if (openCount >= MOONBOY_MAX_OPEN) {
    console.log(`${label} moonboy cap reached (${openCount}/${MOONBOY_MAX_OPEN}) — skipping`)
    return null
  }

  // Dedup: skip if already open for this mint
  const { data: existing } = await supabase
    .from('moonboy_positions')
    .select('id')
    .eq('mint', metrics.address)
    .eq('status', 'open')
    .limit(1)
  if (existing && existing.length > 0) {
    console.log(`${label} moonboy position already open for ${metrics.address.slice(0, 8)}… — skipping`)
    return null
  }

  const isDryRun = process.env.BOT_DRY_RUN === 'true'

  let sig = 'DRY_RUN'
  let solSpent = 0
  let tokenAmountOut = 0n

  if (!isDryRun) {
    try {
      const result = await buyTokenWithSol(metrics.address, solPriceUsd, MOONBOY_BUY_USD, label)
      sig = result.sig
      solSpent = result.solSpent
      tokenAmountOut = result.tokenAmountOut
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${label} moonboy buy failed:`, msg)
      await supabase.from('bot_logs').insert({
        level: 'error', event: 'moonboy_buy_failed',
        payload: { symbol: metrics.symbol, mint: metrics.address, error: msg },
      })
      return null
    }
  } else {
    solSpent = MOONBOY_BUY_USD / (solPriceUsd > 0 ? solPriceUsd : 150)
    console.log(`${label} moonboy DRY RUN — would buy ~$${MOONBOY_BUY_USD} of ${metrics.symbol}`)
  }

  const { data, error } = await supabase
    .from('moonboy_positions')
    .insert({
      mint:            metrics.address,
      symbol:          metrics.symbol,
      entry_price_usd: metrics.priceUsd ?? 0,
      token_amount:    tokenAmountOut.toString(),
      sol_spent:       solSpent,
      status:          'open',
      opened_at:       new Date().toISOString(),
      tx_open:         sig,
      strategy_id:     'moonboy',
      dry_run:         isDryRun,
      sol_price_usd:   solPriceUsd,
      metadata: {
        take_profit_pct:  moonboyStrategy.exits.takeProfitPct,
        stop_loss_pct:    moonboyStrategy.exits.stopLossPct,
        max_duration_hours: moonboyStrategy.exits.maxDurationHours,
        buy_usd:          MOONBOY_BUY_USD,
        market_cap_usd:   metrics.mcUsd,
        volume_24h_usd:   metrics.volume24h,
        age_hours:        metrics.ageHours,
      },
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error(`${label} moonboy DB insert failed:`, error?.message)
    return null
  }

  await sendAlert({
    type: 'moonboy_opened',
    symbol: metrics.symbol,
    mint: metrics.address,
    buyUsd: MOONBOY_BUY_USD,
    solSpent,
    entryPriceUsd: metrics.priceUsd ?? 0,
    takeProfitPct: moonboyStrategy.exits.takeProfitPct,
    stopLossPct: moonboyStrategy.exits.stopLossPct,
  }).catch(() => {})

  console.log(`${label} moonboy position opened ✔ id=${data.id} sig=${sig.slice(0, 8)}…`)
  return data.id
}

export async function checkMoonboyPositions(): Promise<{ checked: number; closed: number }> {
  const supabase = createServerClient()
  const stats = { checked: 0, closed: 0 }

  const { data: positions, error } = await supabase
    .from('moonboy_positions')
    .select('*')
    .eq('status', 'open')

  if (error || !positions?.length) return stats

  const now = Date.now()

  for (const pos of positions as MoonboyRow[]) {
    stats.checked++
    const label = `[moonboy][${pos.symbol}]`

    const currentPriceUsd = await getTokenPriceUsd(pos.mint)
    if (currentPriceUsd === null) {
      console.warn(`${label} price unavailable — skipping tick`)
      continue
    }

    const entryPriceUsd = pos.entry_price_usd
    const pnlPct = entryPriceUsd > 0
      ? ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
      : 0

    const ageHours = (now - new Date(pos.opened_at).getTime()) / 3_600_000

    console.log(
      `${label} price=$${currentPriceUsd.toFixed(6)} entry=$${entryPriceUsd.toFixed(6)} ` +
      `pnl=${pnlPct.toFixed(1)}% age=${ageHours.toFixed(1)}h`,
    )

    // Update current price in DB
    await supabase
      .from('moonboy_positions')
      .update({ current_price_usd: currentPriceUsd, pnl_pct: Math.round(pnlPct * 100) / 100 })
      .eq('id', pos.id)
      .catch(() => {})

    let closeReason: string | null = null
    if (pnlPct >= moonboyStrategy.exits.takeProfitPct) {
      closeReason = `takeprofit_${pnlPct.toFixed(1)}pct`
    } else if (pnlPct <= moonboyStrategy.exits.stopLossPct) {
      closeReason = `stoploss_${pnlPct.toFixed(1)}pct`
    } else if (ageHours >= moonboyStrategy.exits.maxDurationHours) {
      closeReason = `max_duration_${Math.round(ageHours)}h`
    }

    if (!closeReason) continue

    console.log(`${label} EXIT → ${closeReason}`)
    let swapSig: string | null = null
    if (!pos.dry_run) {
      try {
        swapSig = await swapTokenToSol(pos.mint, label)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`${label} moonboy sell failed:`, msg)
        await supabase.from('bot_logs').insert({
          level: 'error', event: 'moonboy_sell_failed',
          payload: { id: pos.id, symbol: pos.symbol, mint: pos.mint, reason: closeReason, error: msg },
        })
        await sendAlert({
          type: 'error',
          message: `⚠️ Moonboy sell FAILED for ${pos.symbol} (${closeReason})\nMint: \`${pos.mint}\`\nTokens stranded in wallet — manual swap required.\nError: ${msg}`,
        }).catch(() => {})
        // Mark as sell_failed so we don't retry forever
        await supabase.from('moonboy_positions').update({ status: 'sell_failed', close_reason: closeReason }).eq('id', pos.id)
        stats.closed++
        continue
      }
    }

    await supabase
      .from('moonboy_positions')
      .update({
        status: 'closed',
        closed_at: new Date().toISOString(),
        close_reason: closeReason,
        tx_close: swapSig ?? 'DRY_RUN',
      })
      .eq('id', pos.id)

    await sendAlert({
      type: 'moonboy_closed',
      symbol: pos.symbol,
      mint: pos.mint,
      pnlPct: Math.round(pnlPct * 100) / 100,
      reason: closeReason,
      ageHours: Math.round(ageHours * 10) / 10,
      swapSig: swapSig ?? 'DRY_RUN',
    }).catch(() => {})

    console.log(`${label} moonboy closed ✔ reason=${closeReason} pnl=${pnlPct.toFixed(1)}%`)
    stats.closed++
  }

  return stats
}
