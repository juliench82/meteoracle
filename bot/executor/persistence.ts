/**
 * bot/executor/persistence.ts
 *
 * Persistence and alerting helpers extracted from the monolithic executor.ts.
 * This keeps the main executor file smaller and more focused.
 */

import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'
import { OPEN_LP_STATUSES } from '@/lib/position-limits'
import { getOpenLpPositions, saveOpenLpPositions } from '@/lib/local-state'

const ENV_DRY_RUN_FORCED = process.env.BOT_DRY_RUN === 'true'

export async function persistPosition(
  metrics: TokenMetrics,
  strategy: Strategy,
  sig: string,
  entryPriceUsd: number,
  entryPriceSol: number,
  solDeposited: number,
  positionPubKey?: string,
  tokenAmount: number = 0,
  dryRun: boolean = ENV_DRY_RUN_FORCED,
  needsLiquidityRetry: boolean = false
): Promise<string> {

  // Idempotency guard: if we already have an active/open row for this mint,
  // return the existing id instead of throwing on the unique constraint.
  // This protects against duplicate open attempts (e.g. after clearing DB and going live,
  // or rapid re-processing of the same candidate).
  const existing = await findExistingActivePosition(metrics.address)
  if (existing) {
    console.log(`[executor] persistPosition — mint ${metrics.symbol} already has active row (id=${existing.id}), returning existing id instead of inserting`)
    return existing.id
  }

  // Safety: never allow the literal string "LIVE" as symbol, even in edge cases.
  const safeSymbol = (metrics.symbol && metrics.symbol !== 'LIVE') ? metrics.symbol : metrics.address;

  // Write to local state (JSON files in state/)
  const newPosition = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    mint:            metrics.address,
    symbol:          safeSymbol,
    pool_address:    metrics.poolAddress,
    position_pubkey: positionPubKey ?? '',
    strategy_id:     strategy.id,
    position_type:   'dlmm',
    token_amount:    tokenAmount,
    sol_deposited:   solDeposited,
    entry_price_usd: entryPriceUsd,
    entry_price_sol: entryPriceSol,
    claimable_fees_usd: 0,
    position_value_usd: 0,
    status:          needsLiquidityRetry ? 'pending_retry' : 'active',
    in_range:        true,
    dry_run:         dryRun,
    opened_at:       new Date().toISOString(),
    tx_open:         sig,
    metadata: {
      strategy_id:           strategy.id,
      strategy_version:      strategy.version,
      bin_range_down:        strategy.position.rangeDownPct,
      bin_range_up:          strategy.position.rangeUpPct,
      // Legacy exit fields removed for ultra-minimal LP model.
      // Only duration + OOR fallback values are kept for getPositionExitRules compatibility.
      maxDurationHours:      strategy.exits.maxDurationHours,
      out_of_range_minutes:  strategy.exits.outOfRangeMinutes,
      market_cap_usd:        metrics.mcUsd,
      volume_24h_usd:        metrics.volume24h,
      dex_liquidity_usd:     metrics.liquidityUsd,
      fee_tvl_24h_pct:       metrics.feeTvl24hPct,
      rugcheck_score:        metrics.rugcheckScore,
      top_holder_pct:        metrics.topHolderPct,
      holder_count:          metrics.holderCount,
      quote_token_mint:      metrics.quoteTokenMint ?? null,
      bin_step:              metrics.binStep ?? null,
      dex_id:                metrics.dexId,
      dex_price_usd:         metrics.priceUsd,
      entry_sol_price_usd:   entryPriceSol > 0 ? entryPriceUsd / entryPriceSol : null,
      needs_liquidity_retry: needsLiquidityRetry,
      // New fields for minimal exit rules
      fee_tvl_samples:       metrics.feeTvl24hPct ? [{ ts: Date.now(), fee_tvl_24h: metrics.feeTvl24hPct }] : [],
      opened_at:             new Date().toISOString(),
    },
  }

  const allPositions = getOpenLpPositions()
  allPositions.push(newPosition)
  saveOpenLpPositions(allPositions)

  return newPosition.id
}

export async function markPositionClosed(
  positionId: string,
  claimableFeesUsd: number | null,
  reason: string
): Promise<void> {
  const positions = getOpenLpPositions()
  const idx = positions.findIndex((p: any) => p.id === positionId)
  if (idx !== -1) {
    positions[idx] = {
      ...positions[idx],
      status: 'closed',
      closed_at: new Date().toISOString(),
      oor_since_at: null,
      close_reason: reason,
      ...(claimableFeesUsd !== null ? { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 } : {}),
    }
    saveOpenLpPositions(positions)
  }
}

export async function sendOpenAlert(
  metrics: TokenMetrics,
  strategy: Strategy,
  positionId: string,
  solDeposited: number,
  entryPriceSol: number,
): Promise<void> {
  try {
    await sendAlert({
      type: 'position_opened',
      symbol: metrics.symbol,
      strategy: strategy.id,
      solDeposited,
      entryPrice: metrics.priceUsd ?? 0,
      positionId,
      volume24h: metrics.volume24h,
      entryPriceUsd: metrics.priceUsd ?? 0,
      entryPriceSol,
      rugcheckScore: metrics.rugcheckScore,
      rugcheckUrl: metrics.rugcheckUrl,
      holderCount: metrics.holderCount,
      topHolderPct: metrics.topHolderPct,
      poolAddress: metrics.poolAddress,
      mint: metrics.address,
      ageMinutes: metrics.ageHours != null ? Math.round(metrics.ageHours * 60) : undefined,
    })
  } catch (alertErr) {
    console.warn('[executor] sendOpenAlert failed (non-fatal):', alertErr)
  }
}

export async function sendCloseAlert(
  position: any,
  claimableFeesUsd: number,
  reason: string
): Promise<void> {
  try {
    const openedAtMs = position.opened_at ? new Date(position.opened_at).getTime() : Date.now()
    const ageHours = parseFloat(((Date.now() - openedAtMs) / 3_600_000).toFixed(1))

    // Rich exit diagnostics persisted by monitor
    const feeTvl4h = position.last_fee_tvl_4h_avg ?? position.metadata?.last_fee_tvl_4h_avg
    const netPnl = position.last_net_pnl_pct ?? position.metadata?.last_net_pnl_pct
    const samplesCount = Array.isArray(position.fee_tvl_samples) ? position.fee_tvl_samples.length : (position.metadata?.fee_tvl_samples?.length ?? 0)

    let oorMin: number | undefined
    if (position.oor_since) {
      oorMin = Math.round((Date.now() - new Date(position.oor_since).getTime()) / 1000 / 60)
    }

    await sendAlert({
      type: 'position_closed',
      symbol: position.symbol,
      strategy: position.metadata?.strategy_id ?? 'unknown',
      reason,
      claimableFeesUsd: Math.round(claimableFeesUsd * 100) / 100,
      ilPct: 0,
      ageHours,
      netPnlPct: typeof netPnl === 'number' ? Math.round(netPnl * 100) / 100 : undefined,
      feeTvl4hAvg: typeof feeTvl4h === 'number' ? Math.round(feeTvl4h * 100) / 100 : undefined,
      feeTvlSampleCount: samplesCount || undefined,
      oorMinutes: oorMin,
      triggeredRule: reason, // the precise close reason string from monitor
    })
  } catch (alertErr) {
    console.warn('[executor] sendCloseAlert failed (non-fatal):', alertErr)
  }
}

/**
 * Check whether this mint already has an active/pending simulation or live record.
 * Used primarily to make the dry-run fast-path idempotent and prevent
 * "duplicate key violates lp_positions_mint_open_unique" spam during observation.
 */
export async function findExistingActivePosition(mint: string): Promise<{ id: string } | null> {
  try {
    const positions = getOpenLpPositions();
    const match = positions.find((p: any) => p.mint === mint && OPEN_LP_STATUSES.includes(p.status));
    return match ? { id: match.id } : null;
  } catch {
    return null
  }
}