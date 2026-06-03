/**
 * lib/strategy-config.ts
 *
 * Minimal centralized env configuration for the current architecture
 * (evil-panda LP only).
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
export const HELIUS_ENABLED = envBool('HELIUS_ENABLED', false)
export const HELIUS_HOLDER_MAX_PAGES = envNumber('HELIUS_HOLDER_MAX_PAGES', 5)

// ── Misc (still referenced by current ultra-simple scanner) ──────
export const DEEP_CHECK_DELAY_MS = envNumber('DEEP_CHECK_DELAY_MS', 800)
export const MIN_LIQUIDITY_USD_FOR_FRESH = envNumber('MIN_LIQUIDITY_USD_FOR_FRESH', 8000)
export const CANDIDATE_DEDUP_HOURS = envNumber('CANDIDATE_DEDUP_HOURS', 1)
export const OOR_RECHECK_HOURS = envNumber('OOR_RECHECK_HOURS', 24)

// ── Scanner entry filter (ultra-simplified model) ──
export const MAX_POOL_AGE_MINUTES = envNumber(
  'MAX_POOL_AGE_MINUTES',
  envNumber('FRESH_SCANNER_MAX_AGE_MINUTES', 60)
)
// Cap on how many fresh age-qualified pools we will deep-check / enrich per scanner tick.
export const MAX_FRESH_DEEP_CHECKS = envNumber('MAX_FRESH_DEEP_CHECKS', 12)

// ── LP Position Exit Rules (ultra-minimal model) ──
// 48h dry-run starting point (2026-06). Tune after observing real Fee/TVL decay curves + net PnL behavior.
// Primary signal: pool-level 24h Fee/TVL efficiency sampled over rolling 4h window.
export const LP_FEE_TVL_EXIT_THRESHOLD = envNumber('LP_FEE_TVL_EXIT_THRESHOLD', 0.75)     // last-4h avg 24h Fee/TVL % below this → exit (e.g. 0.75 = 0.75%)
export const LP_OOR_EXIT_MINUTES       = envNumber('LP_OOR_EXIT_MINUTES', 45)             // minutes out of range before exit
export const LP_NET_LOSS_SL_PCT        = envNumber('LP_NET_LOSS_SL_PCT', -30)             // net PnL % (price move + all fees) stop-loss
export const LP_NET_LOSS_SL_MIN_AGE_MIN = envNumber('LP_NET_LOSS_SL_MIN_AGE_MIN', 20)     // minutes position must be open before net-PnL SL can fire
export const LP_MAX_DURATION_HOURS     = envNumber('LP_MAX_DURATION_HOURS', 24)           // hard safety cap regardless of other signals
export const LP_FEE_TVL_SAMPLE_WINDOW_H = 4                                               // rolling window for avg calculation (hours)

// Pre-open quality gate: max allowed deviation between Meteora pool price and external market price (e.g. 0.05 = 5%).
// Pools with large deviation often have misaligned active bin, leading to bad IL/OOR right after opening.
export const MAX_POOL_PRICE_DEVIATION = envNumber('MAX_POOL_PRICE_DEVIATION', 0.05)

// MAX_POOL_AGE_MINUTES (default 60 via FRESH_SCANNER_MAX_AGE_MINUTES) + MAX_FRESH_DEEP_CHECKS are the main scanner tunables for the ultra-simple fresh-only model.
