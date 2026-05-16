/**
 * bot/executor/persistence.ts
 *
 * Persistence and alerting helpers extracted from the monolithic executor.ts.
 * This keeps the main executor file smaller and more focused.
 */

import { createServerClient } from '@/lib/supabase'
import { sendAlert } from '@/bot/alerter'
import type { Strategy, TokenMetrics } from '@/lib/types'

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
  const supabase = createServerClient()

  const { data, error } = await supabase
    .from('lp_positions')
    .insert({
      mint:            metrics.address,
      symbol:          metrics.symbol,
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
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to persist LP position: ${error.message}`)
  return data.id
}

export async function markPositionClosed(
  positionId: string,
  claimableFeesUsd: number | null,
  reason: string
): Promise<void> {
  const supabase = createServerClient()

  await supabase
    .from('lp_positions')
    .update({
      status:            'closed',
      closed_at:         new Date().toISOString(),
      oor_since_at:      null,
      close_reason:      reason,
      ...(claimableFeesUsd !== null ? { claimable_fees_usd: Math.round(claimableFeesUsd * 100) / 100 } : {}),
    })
    .eq('id', positionId)
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