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

  // Simplified stack: write to local state (JSON files)
  const newPosition = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    mint:            metrics.address,
    symbol:          safeSymbol,
    pool_address:    metrics.poolAddress,
    position_pubkey: positionPubKey ?? null,
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
      maxDurationHours:      strategy.exits.maxDurationHours,
      stop_loss_pct:         strategy.exits.stopLossPct,
      take_profit_pct:       strategy.exits.takeProfitPct,
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
      takeProfitPct: strategy.exits.takeProfitPct,
      stopLossPct: strategy.exits.stopLossPct,
      volume24h: metrics.volume24h,
      entryPriceUsd: metrics.priceUsd ?? 0,
      entryPriceSol,
      meteoracleScore: metrics.score,
      rugcheckScore: metrics.rugcheckScore,
      poolAddress: metrics.poolAddress,
      mint: metrics.address,
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
    const openedAt = position.opened_at ? new Date(position.opened_at).getTime() : Date.now()
    const ageHours = parseFloat(((Date.now() - openedAt) / 3_600_000).toFixed(1))

    await sendAlert({
      type:          'position_closed',
      symbol:        position.symbol,
      strategy:      position.metadata?.strategy_id ?? 'unknown',
      reason,
      claimableFeesUsd: Math.round(claimableFeesUsd * 100) / 100,
      ilPct:         0,
      ageHours,
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
    const { data, error } = await supabase
      .select('id')
      .eq('mint', mint)
      .in('status', OPEN_LP_STATUSES)
      .limit(1)
      .single()

    if (error || !data) return null
    return { id: data.id }
  } catch {
    return null
  }
}