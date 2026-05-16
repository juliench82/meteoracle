/**
 * strategies/damm-edge.ts — DAMM v2 Edge Strategy evaluator.
 *
 * Decides whether a token qualifies for the DAMM edge track.
 * Completely isolated from DLMM strategy selection.
 *
 * RULES:
 * - Meteora-native pools ONLY (pump.fun / Moonshot support is a follow-up).
 * - Age + Fee/TVL gates are now relaxed + env-configurable (see strategy-config.ts).
 * - Still focused on very fresh, high-momentum DAMM v2 edges.
 * - Returns a DammEdgeDecision with full reason for logging either way.
 *
 * ISOLATION RULE: Must NOT import from bot/executor.ts, bot/monitor.ts,
 * or any existing strategy file.
 */

import type { TokenMetrics, DammEdgeDecision, DammPositionParams } from '@/lib/types'

import {
  DAMM_EDGE_MAX_AGE_MINUTES,
  DAMM_EDGE_MIN_FEE_TVL_PCT,
  DAMM_EDGE_MIN_LIQUIDITY_USD,
  DAMM_EDGE_MAX_MC_USD,
} from '@/lib/strategy-config'

// ── Thresholds — now centralized + loosened in Option A strategy review ──────
/**
 * All DAMM Edge thresholds are now pulled from lib/strategy-config.ts
 * so they are env-configurable (DAMM_EDGE_MAX_AGE_MINUTES, etc.).
 *
 * Defaults after loosening:
 * - Age: 25 minutes (was 15)
 * - Fee/TVL: 5% (was 8%)
 * - Liquidity: $25k
 * - Max MC: $5M
 */

const DAMM_SOL_AMOUNT = Number.parseFloat(
  process.env.DAMM_EDGE_SOL_PER_POSITION ??
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.1',
)

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a token should trigger the DAMM v2 edge track.
 *
 * Called from bot/scanner.ts immediately after TokenMetrics are assembled,
 * before getStrategyForToken() / any DLMM path runs.
 *
 * Returns shouldUseDamm=false with a reason for every rejection — all
 * rejections are logged so we can see exactly what is being filtered.
 */
export async function evaluateDammEdge(
  tokenAddress: string,
  metrics: TokenMetrics
): Promise<DammEdgeDecision> {
  const ageMinutes = metrics.ageHours * 60

  // Gate 1: Hard time window — non-negotiable entry condition
  if (ageMinutes > DAMM_EDGE_MAX_AGE_MINUTES) {
    return {
      shouldUseDamm: false,
      reason: `age=${ageMinutes.toFixed(1)}min > ${DAMM_EDGE_MAX_AGE_MINUTES}min ceiling`,
    }
  }

  // Gate 2: Fee/TVL — confirms genuine early trading demand
  if (metrics.feeTvl24hPct < DAMM_EDGE_MIN_FEE_TVL_PCT) {
    return {
      shouldUseDamm: false,
      reason: `feeTvl=${metrics.feeTvl24hPct.toFixed(1)}% < ${DAMM_EDGE_MIN_FEE_TVL_PCT}% min`,
    }
  }

  // Gate 3: Minimum liquidity — avoid thin markets
  if (metrics.liquidityUsd < DAMM_EDGE_MIN_LIQUIDITY_USD) {
    return {
      shouldUseDamm: false,
      reason: `liquidity=$${metrics.liquidityUsd.toFixed(0)} < $${DAMM_EDGE_MIN_LIQUIDITY_USD} min`,
    }
  }

  // Gate 4: Not a bluechip — fresh small-cap only
  if (metrics.mcUsd > DAMM_EDGE_MAX_MC_USD) {
    return {
      shouldUseDamm: false,
      reason: `mc=$${metrics.mcUsd.toFixed(0)} > $${DAMM_EDGE_MAX_MC_USD} max`,
    }
  }

  // All gates passed — build preliminary params. scanner.ts must replace
  // poolAddress with a verified DAMM v2 pool before calling openDammPosition().
  const params: DammPositionParams = {
    tokenAddress,
    poolAddress:  metrics.poolAddress,
    solAmount:    DAMM_SOL_AMOUNT,
    symbol:       metrics.symbol,
    ageMinutes,
    feeTvl24hPct: metrics.feeTvl24hPct,
    liquidityUsd: metrics.liquidityUsd,
  }

  return {
    shouldUseDamm: true,
    reason:
      `damm-edge PASS: age=${ageMinutes.toFixed(1)}min, ` +
      `feeTvl=${metrics.feeTvl24hPct.toFixed(1)}%, ` +
      `liq=$${metrics.liquidityUsd.toFixed(0)}, ` +
      `mc=$${metrics.mcUsd.toFixed(0)}`,
    params,
  }
}
