import * as dotenvLocal from 'dotenv'
import * as path from 'path'
dotenvLocal.config({ path: path.resolve(process.cwd(), '.env.local'), override: false, quiet: true })

import { getConnection, getWallet } from '@/lib/solana'
import { buyTokenWithSol, swapTokenToSol } from '@/lib/swap'
import { sendAlert } from '@/bot/alerter'
import type { TokenMetrics } from '@/lib/types'
import { moonboyStrategy } from '@/strategies/moonboy'
import { getOpenLpPositions, getOpenMoonboys, saveOpenMoonboys } from '@/lib/local-state'
import { logError } from '@/lib/log'

const MOONBOY_BUY_USD = parseFloat(process.env.MOONBOY_BUY_USD ?? '10')
const MOONBOY_MAX_OPEN = parseInt(process.env.MOONBOY_MAX_OPEN ?? '3')
const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/tokens'

const JUPITER_PRICE_API = 'https://api.jup.ag/price/v2'

const isDryRun = process.env.BOT_DRY_RUN === 'true';
const PNL_UNAVAILABLE_ALERT_TICKS = parseInt(
  process.env.MOONBOY_PNL_UNAVAILABLE_ALERT_TICKS ?? (isDryRun ? '5' : '3')
);
const PNL_UNAVAILABLE_FORCE_EXIT_TICKS = parseInt(
  process.env.MOONBOY_PNL_UNAVAILABLE_FORCE_EXIT_TICKS ?? (isDryRun ? '15' : '10')
);
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
  metadata?: {
    highest_price_since_80pct?: number | null
    last_high_timestamp?: string | null
  }
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

/**
 * Primary price source for ongoing Moonboy PnL tracking.
 * Tries Jupiter first (fast + reliable for most tokens), then falls back to DexScreener.
 * This is important for very fresh pump.fun graduates where Jupiter often lags or returns nothing.
 */
async function getMoonboyPriceUsd(mint: string): Promise<number | null> {
  // Try Jupiter first
  const jup = await getJupiterPriceUsd(mint);
  if (jup !== null) {
    return jup;
  }

  // Fallback to DexScreener (often better for brand new tokens)
  console.warn(`[moonboy] Jupiter price unavailable for ${mint} — falling back to DexScreener`);
  return (await getDexScreenerData(mint)).priceUsd;
}

export async function openMoonboyPosition(metrics: TokenMetrics, solPriceUsd: number): Promise<string | null> {
  const label = `[moonboy][${metrics.symbol}]`

  console.log(`${label} evaluating companion spot-buy ($${MOONBOY_BUY_USD} target)`)

  if (!moonboyStrategy.enabled) {
    console.log(`${label} strategy disabled — aborting`)
    return null
  }

  const openCount = (getOpenMoonboys() as any[]).length
  if (openCount >= MOONBOY_MAX_OPEN) {
    console.log(`${label} cap reached (${openCount}/${MOONBOY_MAX_OPEN}) — skipping`)
    return null
  }

  // Dedup: skip if there is already an open Moonboy or one that was opened/closed very recently for this mint.
  // This prevents multiple small buys for the exact same token in a short window (which happened with ALIENS).
  const recentCutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // last 2 hours
  // Local state only
  const recent = getOpenMoonboys().filter((m: any) =>
    m.mint === metrics.address &&
    (m.status === 'open' || (m.opened_at && m.opened_at >= recentCutoff))
  );

  if (recent.length > 0) {
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

  // Fetch DexScreener data for metadata (age at open). The main age gate
  // is now enforced by the scanner's MAX_POOL_AGE_MINUTES before triggering Moonboy.
  const nowMs = Date.now()
  const dexData = await getDexScreenerData(metrics.address)

  const tokenAgeMinutesAtOpen = dexData.pairCreatedAt !== null
    ? (nowMs - dexData.pairCreatedAt) / 60_000
    : null

  // Persist to local state (state/open-moonboys.json)
  const newMoonboy = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
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
    current_price_usd: metrics.priceUsd ?? 0,
    pnl_pct: 0,
    metadata: {
      // Moonboy exits are intentionally read live from moonboyStrategy at decision time
      // (unlike LP positions which snapshot strategy exits at open time - see 6.4 in plan).
      // This is acceptable in the simplified model because Moonboy strategy is very stable.
      take_profit_pct:        moonboyStrategy.exits.takeProfitPct,
      stop_loss_pct:          moonboyStrategy.exits.stopLossPct,
      max_duration_hours:     moonboyStrategy.exits.maxDurationHours,
      buy_usd:                MOONBOY_BUY_USD,
      market_cap_usd:         metrics.mcUsd,
      volume_24h_usd:         metrics.volume24h,
      age_hours:              metrics.ageHours,
      dex_pair_created_at:    dexData.pairCreatedAt,
      token_age_minutes_at_open: tokenAgeMinutesAtOpen,
      // Fields for sophisticated trailing exit logic (Section 6.1)
      highest_price_since_80pct: null,
      last_high_timestamp: null,
    },
  }

  const existingMoonboys = getOpenMoonboys()
  existingMoonboys.push(newMoonboy)
  saveOpenMoonboys(existingMoonboys)

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

  console.log(`${label} position opened ✔ id=${newMoonboy.id} (sig=${sig.slice(0, 8)}…)`)
  return newMoonboy.id
}

export async function checkMoonboyPositions(): Promise<{ checked: number; closed: number }> {
  const stats = { checked: 0, closed: 0 }

  const positions = getOpenMoonboys().filter((p: any) => p.status === 'open')

  if (!positions?.length) return stats

  const now = Date.now()

  for (const pos of positions as MoonboyRow[]) {
    stats.checked++
    const label = `[moonboy][${pos.symbol}]`

    const currentPriceUsd = await getMoonboyPriceUsd(pos.mint)
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

    // === Sophisticated Moonboy trailing exit logic (Section 6.1) ===
    // We track highest price and last high time once we cross 80% of the way to 2x.
    if (!closeReason && currentPriceUsd && entryPriceUsd > 0) {
      const targetPrice = entryPriceUsd * 2;
      const profitPctOfTarget = ((currentPriceUsd - entryPriceUsd) / (targetPrice - entryPriceUsd)) * 100;

      // Load or initialize tracking fields from metadata
      let highestSince = pos.metadata?.highest_price_since_80pct ?? null;
      let lastHighTs = pos.metadata?.last_high_timestamp ? new Date(pos.metadata.last_high_timestamp).getTime() : now;

      if (profitPctOfTarget >= 80) {
        // Update peak tracking
        if (highestSince === null || currentPriceUsd > highestSince) {
          highestSince = currentPriceUsd;
          lastHighTs = now;
        }

        const minutesSinceLastHigh = (now - lastHighTs) / 60_000;

        const decision = shouldSellMoonboy(
          entryPriceUsd,
          currentPriceUsd,
          highestSince,
          minutesSinceLastHigh
        );

        if (decision.shouldSell) {
          closeReason = decision.reason;
        }
      }

      // Persist updated tracking fields (fire-and-forget, same pattern as current price)
      if (highestSince !== pos.metadata?.highest_price_since_80pct || lastHighTs !== (pos.metadata?.last_high_timestamp ? new Date(pos.metadata.last_high_timestamp).getTime() : null)) {
        void Promise.resolve().then(() => {
          const all = getOpenMoonboys();
          const idx = all.findIndex((p: any) => p.id === pos.id);
          if (idx !== -1) {
            if (!all[idx].metadata) all[idx].metadata = {};
            all[idx].metadata.highest_price_since_80pct = highestSince;
            all[idx].metadata.last_high_timestamp = new Date(lastHighTs).toISOString();
            saveOpenMoonboys(all);
          }
        }).catch(() => {});
      }
    }

    // Update current price in local state (fire-and-forget)
    void Promise.resolve().then(() => {
      const all = getOpenMoonboys()
      const idx = all.findIndex((p: any) => p.id === pos.id)
      if (idx !== -1) {
        all[idx].current_price_usd = currentPriceUsd
        all[idx].pnl_pct = Math.round(pnlPct * 100) / 100
        saveOpenMoonboys(all)
      }
    }).catch(() => {})

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

    // Update in local state
    const allMoonboys = getOpenMoonboys()
    const closeIdx = allMoonboys.findIndex((p: any) => p.id === pos.id)
    if (closeIdx !== -1) {
      allMoonboys[closeIdx].status = 'closed'
      allMoonboys[closeIdx].closed_at = new Date().toISOString()
      allMoonboys[closeIdx].close_reason = closeReason
      allMoonboys[closeIdx].tx_close = swapSig ?? 'DRY_RUN'
      saveOpenMoonboys(allMoonboys)
    }

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
