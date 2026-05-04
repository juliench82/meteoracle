/**
 * strategies/damm-edge.ts — DAMM v2 Edge Strategy evaluator.
 *
 * Decides whether a token qualifies for the DAMM edge track.
 * Completely isolated from DLMM strategy selection.
 *
 * RULES:
 * - Meteora-native pools ONLY (pump.fun / Moonshot support is a follow-up).
 * - Hard 15-minute age ceiling — non-negotiable.
 * - Strict fee/TVL, liquidity, and market cap gates.
 * - Returns a DammEdgeDecision with full reason for logging either way.
 *
 * ISOLATION RULE: Must NOT import from bot/executor.ts, bot/monitor.ts,
 * or any existing strategy file.
 */

import type { TokenMetrics, DammEdgeDecision, DammPositionParams } from '@/lib/types'

// ── Thresholds — tune these independently of all DLMM strategies ─────────────

/** Hard ceiling. Anything older is automatically rejected. */
const DAMM_MAX_AGE_MINUTES = 15

/**
 * Minimum 24h fee/TVL %. Must be very high — we are looking for genuine
 * early demand, not stale volume. Matches the existing METEORA_NEW_LISTING_FEETVL
 * constant in scanner.ts (8%) so both detection paths are consistent.
 */
const DAMM_MIN_FEE_TVL_PCT = 8

/**
 * Minimum pool liquidity in USD. Prevents entering dust pools where
 * a small SOL deposit would move the price significantly.
 */
const DAMM_MIN_LIQUIDITY_USD = 25_000

/**
 * Maximum market cap. We are NOT targeting bluechips or established tokens —
 * this edge only exists on very fresh small-caps.
 */
const DAMM_MAX_MC_USD = 5_000_000

const DAMM_SOL_AMOUNT = Number.parseFloat(
  process.env.DAMM_EDGE_SOL_PER_POSITION ??
  process.env.MAX_MARKET_LP_SOL_PER_POSITION ??
  process.env.MARKET_LP_SOL_PER_POSITION ??
  process.env.MAX_SOL_PER_POSITION ??
  '0.05',
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
  if (ageMinutes > DAMM_MAX_AGE_MINUTES) {
    return {
      shouldUseDamm: false,
      reason: `age=${ageMinutes.toFixed(1)}min > ${DAMM_MAX_AGE_MINUTES}min ceiling`,
    }
  }

  // Gate 2: Fee/TVL — confirms genuine early trading demand
  if (metrics.feeTvl24hPct < DAMM_MIN_FEE_TVL_PCT) {
    return {
      shouldUseDamm: false,
      reason: `feeTvl=${metrics.feeTvl24hPct.toFixed(1)}% < ${DAMM_MIN_FEE_TVL_PCT}% min`,
    }
  }

  // Gate 3: Minimum liquidity — avoid thin markets
  if (metrics.liquidityUsd < DAMM_MIN_LIQUIDITY_USD) {
    return {
      shouldUseDamm: false,
      reason: `liquidity=$${metrics.liquidityUsd.toFixed(0)} < $${DAMM_MIN_LIQUIDITY_USD} min`,
    }
  }

  // Gate 4: Not a bluechip — fresh small-cap only
  if (metrics.mcUsd > DAMM_MAX_MC_USD) {
    return {
      shouldUseDamm: false,
      reason: `mc=$${metrics.mcUsd.toFixed(0)} > $${DAMM_MAX_MC_USD} max`,
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
