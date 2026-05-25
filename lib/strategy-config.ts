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

export function envBool(name: string, fallback = false): boolean {
  const value = process.env[name]
  if (value === undefined) return fallback
  const normalized = value.toLowerCase().trim()
  return normalized === 'true' || normalized === '1' || normalized === 'yes'
}

// ─────────────────────────────────────────────────────────────────────────────
// Common Scanner / Strategy Tuning Constants (with env overrides)
// ─────────────────────────────────────────────────────────────────────────────

export const SCALP_SPIKE_VOL_RATIO = envNumber('SCALP_SPIKE_VOL_RATIO', 2.0)
export const SCALP_SPIKE_MIN_FEE_TVL_1H_PCT = envNumber('SCALP_SPIKE_MIN_FEE_TVL_1H_PCT', 1)
export const SCALP_SPIKE_MIN_FEE_TVL_5M_PCT = envNumber('SCALP_SPIKE_MIN_FEE_TVL_5M_PCT', 0.05)
export const SCALP_SPIKE_MIN_RUGCHECK_SCORE = envNumber('SCALP_SPIKE_MIN_RUGCHECK_SCORE', 50)
export const SCALP_SPIKE_MIN_HOLDER_COUNT = envNumber('SCALP_SPIKE_MIN_HOLDER_COUNT', 150)

export const EVIL_PANDA_MIN_HOLDER_COUNT = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT', 50)
export const EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M', 50)

// Evil Panda defaults — raised max age to 48h (from the 24h candidates analysis) so pump.fun graduates
// that take time to surface in DLMM feeds or are 1-2 days old with strong rug/binStep still get considered.
export const EVIL_PANDA_MAX_AGE_HOURS = envNumber('EVIL_PANDA_MAX_AGE_HOURS', 48)
export const EVIL_PANDA_MIN_RUGCHECK_SCORE = envNumber('EVIL_PANDA_MIN_RUGCHECK_SCORE', 40)

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

// Fresh / Snipe lane — raised to 90min so early pump.fun graduates (e.g. binStep=100, score~75, ~0.7h old) qualify for snipe/open track
export const FRESH_SNIPE_MAX_AGE_MINUTES = envNumber('FRESH_SNIPE_MAX_AGE_MINUTES', 90)
export const FRESH_MIN_LIQUIDITY_USD = envNumber(
  'FRESH_MIN_LIQUIDITY_USD',
  envNumber('EVIL_PANDA_MIN_LIQUIDITY_USD', 20000)
)

// Misc
export const CANDIDATE_DEDUP_HOURS = envNumber('CANDIDATE_DEDUP_HOURS', 1)
export const HARD_MAX_TOKEN_AGE_MINUTES = envNumber('HARD_MAX_TOKEN_AGE_MINUTES', 120) as number
export const OOR_RECHECK_HOURS = envNumber('OOR_RECHECK_HOURS', 24)
export const SCANNER_EARLY_MAX_AGE_MINUTES = envNumber('SCANNER_EARLY_MAX_AGE_MINUTES', 90)

// Two-track system (snipe vs mature) — lowered to 70 so score-75 candidates on mature track still open
export const MATURE_MIN_SCORE_TO_OPEN = envNumber('MATURE_MIN_SCORE_TO_OPEN', 70)

// ── Scanner core timing (single source of truth) ────────────────────────────
export const LP_SCAN_INTERVAL_SEC = envNumber('LP_SCAN_INTERVAL_SEC', 900)
export const SCAN_INTERVAL_MS = LP_SCAN_INTERVAL_SEC * 1000

const DEFAULT_SCANNER_TICK_TIMEOUT_MS = Math.max(60_000, SCAN_INTERVAL_MS - 30_000)
export const SCANNER_TICK_TIMEOUT_MS = Math.max(
  60_000,
  envNumber(
    'LP_SCANNER_TICK_TIMEOUT_MS',
    envNumber('SCANNER_TICK_TIMEOUT_MS', DEFAULT_SCANNER_TICK_TIMEOUT_MS)
  )
)

// Fresh age gate respects both user setting and the early-age hard limit
export const FRESH_MAX_AGE_MINUTES = Math.min(
  envNumber('FRESH_SCANNER_MAX_AGE_MINUTES', HARD_MAX_TOKEN_AGE_MINUTES),
  SCANNER_EARLY_MAX_AGE_MINUTES
) as number

// ── Feature flags / enabled switches ────────────────────────────────────────
export const SCANNER_ENABLED = envBool('SCANNER_ENABLED', true)
export const LP_SCANNER_ENABLED = envBool('LP_SCANNER_ENABLED', true) && SCANNER_ENABLED
export const EVIL_PANDA_ENABLED = envBool('EVIL_PANDA_ENABLED', true)
export const SCALP_SPIKE_ENABLED = envBool('SCALP_SPIKE_ENABLED', true)
export const STABLE_FARM_ENABLED = envBool('STABLE_FARM_ENABLED', true)
export const BLUECHIP_FARM_ENABLED = envBool('BLUECHIP_FARM_ENABLED', false)
export const MOONBOY_ENABLED = envBool('MOONBOY_ENABLED', true)

// ── Scoring & deep-check tuning ─────────────────────────────────────────────
export const MIN_SCORE_TO_OPEN = envNumber('MIN_SCORE_TO_OPEN', 65)

// ── Advanced scanner knobs ──────────────────────────────────────────────────
export const MOMENTUM_POOL_LIMIT = envNumber('MOMENTUM_POOL_LIMIT', 500)
export const HELIUS_HOLDER_MAX_PAGES = envNumber('HELIUS_HOLDER_MAX_PAGES', 1)

// Re-export HELIUS_ENABLED for convenience (used in helius.ts)
export const HELIUS_ENABLED = envBool('HELIUS_ENABLED', false)

console.log('[strategy-config] centralized env configuration loaded')