/**
 * lib/strategy-config.ts
 *
 * Centralized environment-driven configuration for strategies and scanner tuning.
 * Single source of truth for all envNumber calls + common constants.
 *
 * Usage:
 *   import { envNumber, SCALP_SPIKE_VOL_RATIO, ... } from '@/lib/strategy-config'
 */

export function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

// ─────────────────────────────────────────────────────────────────────────────
// Common Scanner / Strategy Tuning Constants (with env overrides)
// ─────────────────────────────────────────────────────────────────────────────

export const SCALP_SPIKE_VOL_RATIO = envNumber('SCALP_SPIKE_VOL_RATIO', 2.5)
export const SCALP_SPIKE_MIN_FEE_TVL_1H_PCT = envNumber('SCALP_SPIKE_MIN_FEE_TVL_1H_PCT', 1)
export const SCALP_SPIKE_MIN_FEE_TVL_5M_PCT = envNumber('SCALP_SPIKE_MIN_FEE_TVL_5M_PCT', 0.1)
export const SCALP_SPIKE_MIN_RUGCHECK_SCORE = envNumber('SCALP_SPIKE_MIN_RUGCHECK_SCORE', 60)
export const SCALP_SPIKE_MIN_HOLDER_COUNT = envNumber('SCALP_SPIKE_MIN_HOLDER_COUNT', 150)

export const EVIL_PANDA_MIN_HOLDER_COUNT = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT', 50)
export const EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M', 50)

// Evil Panda relaxed defaults (Option A strategy review)
export const EVIL_PANDA_MAX_AGE_HOURS = envNumber('EVIL_PANDA_MAX_AGE_HOURS', 3)
export const EVIL_PANDA_MIN_RUGCHECK_SCORE = envNumber('EVIL_PANDA_MIN_RUGCHECK_SCORE', 50)

// Re-export for convenience in deep-checker / scorer
export const MOMENTUM_MIN_VOLUME_5M_USD = envNumber('MOMENTUM_MIN_VOLUME_5M_USD', 5000)
export const MOMENTUM_MIN_FEE_TVL_5M_PCT = envNumber('MOMENTUM_MIN_FEE_TVL_5M_PCT', 0.1)

// Default position sizing
export const MARKET_LP_SOL_PER_POSITION = envNumber(
  'MAX_MARKET_LP_SOL_PER_POSITION',
  envNumber('MARKET_LP_SOL_PER_POSITION', envNumber('MAX_SOL_PER_POSITION', 0.1))
)

export const MAX_CONCURRENT_MARKET_LP_POSITIONS = envNumber(
  'MAX_CONCURRENT_MARKET_LP_POSITIONS',
  envNumber('MAX_CONCURRENT_POSITIONS', 5)
) as number

export const MAX_MARKET_LP_SOL_DEPLOYED = envNumber(
  'MAX_MARKET_LP_SOL_DEPLOYED',
  envNumber('MAX_TOTAL_SOL_DEPLOYED', 1)
)

// Deep check tuning
export const DEEP_CHECK_DELAY_MS = envNumber('DEEP_CHECK_DELAY_MS', 800)  // P1: was 3000 — big speedup
export const MAX_DEEP_CHECKS = envNumber('MAX_DEEP_CHECKS', 6) as number
export const MAX_FRESH_DEEP_CHECKS = envNumber('MAX_FRESH_DEEP_CHECKS', MAX_DEEP_CHECKS) as number
export const MAX_MOMENTUM_DEEP_CHECKS = envNumber('MAX_MOMENTUM_DEEP_CHECKS', MAX_DEEP_CHECKS) as number

// Fresh lane
export const FRESH_MAX_AGE_MINUTES = envNumber('FRESH_SCANNER_MAX_AGE_MINUTES', 90) as number
export const FRESH_MIN_LIQUIDITY_USD = envNumber(
  'FRESH_MIN_LIQUIDITY_USD',
  envNumber('EVIL_PANDA_MIN_LIQUIDITY_USD', 20000)
)

// Misc
export const CANDIDATE_DEDUP_HOURS = envNumber('CANDIDATE_DEDUP_HOURS', 1)
export const HARD_MAX_TOKEN_AGE_MINUTES = envNumber('HARD_MAX_TOKEN_AGE_MINUTES', 120) as number

// ─────────────────────────────────────────────────────────────────────────────
// DAMM Edge (isolated track) — loosened in Option A strategy review
// ─────────────────────────────────────────────────────────────────────────────
export const DAMM_EDGE_MAX_AGE_MINUTES = envNumber('DAMM_EDGE_MAX_AGE_MINUTES', 25)
export const DAMM_EDGE_MIN_FEE_TVL_PCT = envNumber('DAMM_EDGE_MIN_FEE_TVL_PCT', 5)
export const DAMM_EDGE_MIN_LIQUIDITY_USD = envNumber('DAMM_EDGE_MIN_LIQUIDITY_USD', 25_000)
export const DAMM_EDGE_MAX_MC_USD = envNumber('DAMM_EDGE_MAX_MC_USD', 5_000_000)

console.log('[strategy-config] centralized env configuration loaded')