import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { getConnection, getWallet } from '@/lib/solana'
import { buyTokenWithSol, swapTokenToSol } from '@/lib/swap'
import { sendAlert } from '@/bot/alerter'
import type { TokenMetrics } from '@/lib/types'
import { moonboyStrategy } from '@/strategies/moonboy'
import { logError } from '@/lib/log'

const MOONBOY_BUY_USD = parseFloat(process.env.MOONBOY_BUY_USD ?? '10')
const MOONBOY_MAX_OPEN = parseInt(process.env.MOONBOY_MAX_OPEN ?? '3')
const MOONBOY_MAX_TOKEN_AGE_MINUTES = parseFloat(
  process.env.MOONBOY_MAX_TOKEN_AGE_MINUTES ?? '90',
)
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens'

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2'

const PNL_UNAVAILABLE_ALERT_TICKS = 3
const PNL_UNAVAILABLE_FORCE_EXIT_TICKS = 10
const _moonboyNullPnlTicks = new Map<string, number>()

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

type DexScreenerResult = {
  priceUsd: number | null
  pairCreatedAt: number | null // unix ms
}

async function getDexScreenerData(mint: string): Promise<DexScreenerResult> {
  try {
    const res = await fetch(`${DEXSCREENER_API}/${mint}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { priceUsd: null, pairCreatedAt: null }
    const data = await res.json()
    const pairs: any[] = data?.pairs ?? []
    if (pairs.length === 0) return { priceUsd: null, pairCreatedAt: null }
    // Prefer Solana pairs, fall back to first result
    const pair = pairs.find((p: any) => p.chainId === 'solana') ?? pairs[0]
    const price = parseFloat(pair?.priceUsd ?? '0')
    return {
      priceUsd: price > 0 ? price : null,
      pairCreatedAt: typeof pair?.pairCreatedAt === 'number' ? pair.pairCreatedAt : null,
    }
  } catch {
    return { priceUsd: null, pairCreatedAt: null }
  }
}

async function getJupiterPriceUsd(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return null
    const data = await res.json()
    const price = data?.data?.[mint]?.price
    return typeof price === 'number' && price > 0 ? price : null
  } catch {
    return null
  }
}

/** Backward-compat wrapper used by checkMoonboyPositions price refresh. */
async function getTokenPriceUsd(mint: string): Promise<number | null> {
  return (await getDexScreenerData(mint)).priceUsd
}

  const { count } = await supabase
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
  return count ?? 0
}

export async function openMoonboyPosition(metrics: TokenMetrics, solPriceUsd: number): Promise<string | null> {
  const label = `[moonboy][${metrics.symbol}]`

  console.log(`${label} evaluating companion spot-buy ($${MOONBOY_BUY_USD} target)`)

  if (!moonboyStrategy.enabled) {
    console.log(`${label} strategy disabled — aborting`)
    return null
  }

  // ── DexScreener age gate ──────────────────────────────────────────────────
  // Token age is measured from pairCreatedAt in DexScreener data, not Meteora.
  // We have both a max age (don't buy stale) and a min age for Moonboy buys (avoid the absolute worst simulation failures on ultra-fresh launches).
  const dexData = await getDexScreenerData(metrics.address)
  const nowMs = Date.now()
  if (dexData.pairCreatedAt !== null) {
    const tokenAgeMinutes = (nowMs - dexData.pairCreatedAt) / 60_000

    // Skip ultra-fresh tokens for Moonboy — sells are extremely unreliable in the first ~45 minutes.
    const MOONBOY_MIN_AGE_MINUTES = 45
    if (tokenAgeMinutes < MOONBOY_MIN_AGE_MINUTES) {
      console.log(`${label} skipped — too fresh for reliable Moonboy sell (${tokenAgeMinutes.toFixed(1)}m < ${MOONBOY_MIN_AGE_MINUTES}m)`)
      return null
    }

    if (tokenAgeMinutes > MOONBOY_MAX_TOKEN_AGE_MINUTES) {
      console.log(
        `${label} skipped — DexScreener age ${tokenAgeMinutes.toFixed(1)}m > ${MOONBOY_MAX_TOKEN_AGE_MINUTES}m limit`
      )
      return null
    }
    console.log(`${label} DexScreener age gate passed (${tokenAgeMinutes.toFixed(1)}m old)`)
  } else {
    console.warn(`${label} moonboy age gate — pairCreatedAt unavailable from DexScreener, skipping to be safe`)
    return null
  }
  // ─────────────────────────────────────────────────────────────────────────

  const openCount = await countOpenMoonboys(supabase)
  if (openCount >= MOONBOY_MAX_OPEN) {
    console.log(`${label} cap reached (${openCount}/${MOONBOY_MAX_OPEN}) — skipping`)
    return null
  }

  // Dedup: skip if there is already an open Moonboy or one that was opened/closed very recently for this mint.
  // This prevents multiple small buys for the exact same token in a short window (which happened with ALIENS).
  const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // last 2 hours
  const { data: recent } = await supabase
    .select('id')
    .eq('mint', metrics.address)
    .or(`status.eq.open,opened_at.gte.${recentCutoff}`)
    .limit(1);

  if (recent && recent.length > 0) {
    console.log(`${label} already have recent Moonboy activity for this mint — skipping duplicate buy`)
    return null
  }

  console.log(`${label} all gates passed — proceeding with buy`)

  const isDryRun = process.env.BOT_DRY_RUN === 'true'

  let sig = 'DRY_RUN'
  let solSpent = 0
  let tokenAmountOut = 0n

  if (!isDryRun) {
    try {
      console.log(`${label} executing Jupiter buy (~$${MOONBOY_BUY_USD})...`)
      const result = await buyTokenWithSol(metrics.address, solPriceUsd, MOONBOY_BUY_USD, label)
      sig = result.sig
      solSpent = result.solSpent
      tokenAmountOut = result.tokenAmountOut
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${label} buy failed:`, msg)
      logError('moonboy_buy_failed', { symbol: metrics.symbol, mint: metrics.address, error: msg })
      return null
    }
  } else {
    solSpent = MOONBOY_BUY_USD / (solPriceUsd > 0 ? solPriceUsd : 150)
    console.log(`${label} DRY RUN — would buy ~$${MOONBOY_BUY_USD}`)
  }

  const tokenAgeMinutesAtOpen = dexData.pairCreatedAt !== null
    ? (nowMs - dexData.pairCreatedAt) / 60_000
    : null

  const { data, error } = await supabase
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
        take_profit_pct:        moonboyStrategy.exits.takeProfitPct,
        stop_loss_pct:          moonboyStrategy.exits.stopLossPct,
        max_duration_hours:     moonboyStrategy.exits.maxDurationHours,
        buy_usd:                MOONBOY_BUY_USD,
        market_cap_usd:         metrics.mcUsd,
        volume_24h_usd:         metrics.volume24h,
        age_hours:              metrics.ageHours,
        dex_pair_created_at:    dexData.pairCreatedAt,
        token_age_minutes_at_open: tokenAgeMinutesAtOpen,
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

  console.log(`${label} position opened ✔ id=${data.id} (sig=${sig.slice(0, 8)}…)`)
  return data.id
}

export async function checkMoonboyPositions(): Promise<{ checked: number; closed: number }> {
  const stats = { checked: 0, closed: 0 }

  const { data: positions, error } = await supabase
    .select('*')
    .eq('status', 'open')

  if (error || !positions?.length) return stats

  const now = Date.now()

  for (const pos of positions as MoonboyRow[]) {
    stats.checked++
    const label = `[moonboy][${pos.symbol}]`

    const currentPriceUsd = await getJupiterPriceUsd(pos.mint)
    const previousNullPnlTicks = _moonboyNullPnlTicks.get(pos.id) ?? 0
    let currentNullPnlTicks = previousNullPnlTicks
    let closeReason: string | null = null

    const ageHours = (now - new Date(pos.opened_at).getTime()) / 3_600_000

    if (currentPriceUsd === null) {
      currentNullPnlTicks = previousNullPnlTicks + 1
      _moonboyNullPnlTicks.set(pos.id, currentNullPnlTicks)
      if (currentNullPnlTicks >= PNL_UNAVAILABLE_ALERT_TICKS) {
        if (currentNullPnlTicks === PNL_UNAVAILABLE_ALERT_TICKS || currentNullPnlTicks % PNL_UNAVAILABLE_ALERT_TICKS === 0) {
          await sendAlert({
            type: 'pnl_unavailable_warning',
            symbol: pos.symbol,
            strategy: 'moonboy',
            positionId: pos.id,
            reason: `moonboy_pnl_unavailable_${currentNullPnlTicks}ticks`,
            ageHours: Math.round(ageHours * 10) / 10,
          }).catch(() => {})
        }
        console.warn(`${label} Moonboy PnL unavailable ${currentNullPnlTicks} consecutive ticks`)
      }
      if (currentNullPnlTicks >= PNL_UNAVAILABLE_FORCE_EXIT_TICKS) {
        closeReason = `pnl_unavailable_${PNL_UNAVAILABLE_FORCE_EXIT_TICKS}ticks`
      } else {
        continue
      }
    } else {
      currentNullPnlTicks = 0
      _moonboyNullPnlTicks.set(pos.id, 0)
    }

    const entryPriceUsd = pos.entry_price_usd
    const pnlPct = entryPriceUsd > 0 && currentPriceUsd !== null
      ? ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
      : 0

    console.log(
      `${label} price=$${currentPriceUsd ? currentPriceUsd.toFixed(6) : 'n/a'} entry=$${entryPriceUsd.toFixed(6)} ` +
      `pnl=${pnlPct.toFixed(1)}% age=${ageHours.toFixed(1)}h`,
    )

    // Update current price in DB (fire-and-forget, non-fatal)
    void Promise.resolve(
      supabase
        .update({ current_price_usd: currentPriceUsd, pnl_pct: Math.round(pnlPct * 100) / 100 })
        .eq('id', pos.id),
    ).catch(() => {})

    if (!closeReason) {
      if (pnlPct >= moonboyStrategy.exits.takeProfitPct) {
        closeReason = `takeprofit_${pnlPct.toFixed(1)}pct`
      } else if (pnlPct <= moonboyStrategy.exits.stopLossPct) {
        closeReason = `stoploss_${pnlPct.toFixed(1)}pct`
      } else if (ageHours >= moonboyStrategy.exits.maxDurationHours) {
        closeReason = `max_duration_${Math.round(ageHours)}h`
      }
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
        logError('moonboy_sell_failed', { id: pos.id, symbol: pos.symbol, mint: pos.mint, reason: closeReason, error: msg })
        await sendAlert({
          type: 'error',
          message: `⚠️ Moonboy sell FAILED for ${pos.symbol} (${closeReason})\nMint: \`${pos.mint}\`\nTokens stranded in wallet — manual swap required.\nError: ${msg}`,
        }).catch(() => {})
        // Mark as sell_failed so we don't retry forever
        stats.closed++
        continue
      }
    }

    await supabase
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

// ─────────────────────────────────────────────────────────────────────────────
// Flexible Moonboy exit logic (as requested)
// Sell conditions:
// - Reach 100% of 2x → sell anyway
// - Reach 80% of 2x + 15 minutes without a new high → sell
// - From 80% of 2x: trailing stop of 20% from the peak reached
// ─────────────────────────────────────────────────────────────────────────────

const MOONBOY_PROFIT_THRESHOLD_PCT = 80; // % of the way to 2x to start special rules
const MOONBOY_NO_HIGH_MINUTES = 15;
const MOONBOY_TRAILING_DROP_PCT = 20;

export function shouldSellMoonboy(
  entryPriceUsd: number,
  currentPriceUsd: number,
  highestPriceSinceThreshold: number,
  minutesSinceLastHigh: number
): { shouldSell: boolean; reason: string } {
  if (!entryPriceUsd || entryPriceUsd <= 0 || !currentPriceUsd) {
    return { shouldSell: false, reason: '' };
  }

  const targetPrice = entryPriceUsd * 2;
  const profitPctOfTarget = ((currentPriceUsd - entryPriceUsd) / (targetPrice - entryPriceUsd)) * 100;

  // Always sell at 100% of 2x
  if (currentPriceUsd >= targetPrice) {
    return { shouldSell: true, reason: 'take_profit_2x' };
  }

  // Once we crossed the threshold (80%)
  if (profitPctOfTarget >= MOONBOY_PROFIT_THRESHOLD_PCT) {
    // Time-based: 15min without new high after 80%
    if (minutesSinceLastHigh >= MOONBOY_NO_HIGH_MINUTES) {
      return { shouldSell: true, reason: `take_profit_80pct_no_high_${MOONBOY_NO_HIGH_MINUTES}min` };
    }

    // Trailing stop: 20% drop from the peak reached after 80%
    if (highestPriceSinceThreshold > 0) {
      const dropFromPeak = ((highestPriceSinceThreshold - currentPriceUsd) / highestPriceSinceThreshold) * 100;
      if (dropFromPeak >= MOONBOY_TRAILING_DROP_PCT) {
        return { shouldSell: true, reason: `trailing_20pct_from_peak` };
      }
    }
  }

  return { shouldSell: false, reason: '' };
}
