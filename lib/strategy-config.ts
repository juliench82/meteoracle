/**
 * lib/strategy-config.ts
 *
 * Minimal centralized env configuration for the current architecture
 * (evil-panda LP + moonboy spot buys only).
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

// ── Evil Panda (main LP strategy) ───────────────────────────────
export const EVIL_PANDA_MIN_HOLDER_COUNT = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT', 50)
export const EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M', 50)
export const EVIL_PANDA_MAX_AGE_HOURS = envNumber('EVIL_PANDA_MAX_AGE_HOURS', 48)
export const EVIL_PANDA_MIN_RUGCHECK_SCORE = envNumber('EVIL_PANDA_MIN_RUGCHECK_SCORE', 40)

// ── Position sizing ─────────────────────────────────────────────
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

// ── Scanner timing ──────────────────────────────────────────────
export const LP_SCAN_INTERVAL_SEC = envNumber('LP_SCAN_INTERVAL_SEC', 900)
export const SCAN_INTERVAL_MS = LP_SCAN_INTERVAL_SEC * 1000

export const SCANNER_TICK_TIMEOUT_MS = Math.max(
  60_000,
  envNumber('LP_SCANNER_TICK_TIMEOUT_MS', envNumber('SCANNER_TICK_TIMEOUT_MS', 570_000))
)

export const MAX_POOL_AGE_MINUTES_FOR_LP = envNumber('FRESH_SCANNER_MAX_AGE_MINUTES', 60)

// ── Feature flags ───────────────────────────────────────────────
export const SCANNER_ENABLED = envBool('SCANNER_ENABLED', true)
export const LP_SCANNER_ENABLED = envBool('LP_SCANNER_ENABLED', true) && SCANNER_ENABLED
export const EVIL_PANDA_ENABLED = envBool('EVIL_PANDA_ENABLED', true)
export const MOONBOY_ENABLED = envBool('MOONBOY_ENABLED', true)
export const HELIUS_ENABLED = envBool('HELIUS_ENABLED', false)
export const HELIUS_HOLDER_MAX_PAGES = envNumber('HELIUS_HOLDER_MAX_PAGES', 5)

// ── Misc ────────────────────────────────────────────────────────
export const DEEP_CHECK_DELAY_MS = envNumber('DEEP_CHECK_DELAY_MS', 800)
export const MIN_LIQUIDITY_USD_FOR_FRESH = envNumber('MIN_LIQUIDITY_USD_FOR_FRESH', 8000) // legacy
export const CANDIDATE_DEDUP_HOURS = envNumber('CANDIDATE_DEDUP_HOURS', 1)
export const OOR_RECHECK_HOURS = envNumber('OOR_RECHECK_HOURS', 24)
export const MIN_SCORE_TO_OPEN = envNumber('MIN_SCORE_TO_OPEN', 65) // legacy – removed from fresh entry decisions

// ── Scanner entry filter (ultra-simplified model) ──
export const MAX_POOL_AGE_MINUTES = envNumber('MAX_POOL_AGE_MINUTES', 30)

// ── Scanner lane / survivor limits (legacy - being removed in minimal model) ──
// **No longer used** for opening decisions.
// Only MAX_POOL_AGE_MINUTES controls the fresh gate.
// These will be deleted in the cleanup pass.
// export const FRESH_MAX_AGE_MINUTES = envNumber('FRESH_MAX_AGE_MINUTES', 120)
// export const FRESH_MIN_LIQUIDITY_USD = envNumber('FRESH_MIN_LIQUIDITY_USD', 8000)
// export const MOMENTUM_MIN_VOLUME_5M_USD = envNumber('MOMENTUM_MIN_VOLUME_5M_USD', 3000)
// export const MOMENTUM_MIN_FEE_TVL_5M_PCT = envNumber('MOMENTUM_MIN_FEE_TVL_5M_PCT', 0.5)
// export const MAX_FRESH_DEEP_CHECKS = envNumber('MAX_FRESH_DEEP_CHECKS', 8)
// export const MAX_MOMENTUM_DEEP_CHECKS = envNumber('MAX_MOMENTUM_DEEP_CHECKS', 6)

// Shim (no longer referenced in simplified scanner)
export const classifyToken = () => ({})
