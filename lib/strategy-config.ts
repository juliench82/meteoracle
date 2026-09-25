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
export const EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M = envNumber('EVIL_PANDA_MIN_HOLDER_COUNT_UNDER_60M', 50)  // not used in current scanner (kept for compatibility)
export const EVIL_PANDA_MAX_AGE_HOURS = envNumber('EVIL_PANDA_MAX_AGE_HOURS', 48)
export const EVIL_PANDA_MIN_RUGCHECK_SCORE = envNumber('EVIL_PANDA_MIN_RUGCHECK_SCORE', 60)
export const EVIL_PANDA_MIN_LIQUIDITY_USD = envNumber('EVIL_PANDA_MIN_LIQUIDITY_USD', 500)  // must match server-side MIN_TVL_USD floor to avoid wasting deep-check quota on pools the scanner already accepted

// ── Position sizing ─────────────────────────────────────────────
// Single preferred env var per setting. Legacy names (MARKET_*, MAX_*) removed.
export const MARKET_LP_SOL_PER_POSITION = envNumber('MAX_MARKET_LP_SOL_PER_POSITION', 0.1)

/**
 * Effective SOL deployed per LP position — the single source of truth for position sizing.
 *
 * Always `MARKET_LP_SOL_PER_POSITION`. The former per-strategy override
 * (`strategy.position.maxSolPerPosition`) was dead: strategies/evil-panda.ts never set it,
 * so it was always `undefined` and always fell through to this cap. The branch (and the
 * field) were removed in M5 — this helper is behaviour-identical and testable in isolation.
 */
export function getPositionSolAmount(): number {
  return MARKET_LP_SOL_PER_POSITION
}

export const MAX_CONCURRENT_MARKET_LP_POSITIONS = envNumber('MAX_CONCURRENT_MARKET_LP_POSITIONS', 5) as number

export const MAX_MARKET_LP_SOL_DEPLOYED = envNumber('MAX_MARKET_LP_SOL_DEPLOYED', 1)

// Dedicated fixed SOL amount for the separate token acquisition swap (before opening position).
// This can differ from the SOL leg used in the actual LP position.
export const SWAP_BUY_SOL_AMOUNT = envNumber('SWAP_BUY_SOL_AMOUNT', MARKET_LP_SOL_PER_POSITION)

// ── Scanner timing ──────────────────────────────────────────────
export const LP_SCAN_INTERVAL_SEC = envNumber('LP_SCAN_INTERVAL_SEC', 900)
export const SCAN_INTERVAL_MS = LP_SCAN_INTERVAL_SEC * 1000

export const SCANNER_TICK_TIMEOUT_MS = Math.max(
  60_000,
  envNumber('LP_SCANNER_TICK_TIMEOUT_MS', envNumber('SCANNER_TICK_TIMEOUT_MS', 570_000))
)

// ── Feature flags ───────────────────────────────────────────────
export const SCANNER_ENABLED = envBool('SCANNER_ENABLED', true)
export const LP_SCANNER_ENABLED = envBool('LP_SCANNER_ENABLED', true) && SCANNER_ENABLED
export const EVIL_PANDA_ENABLED = envBool('EVIL_PANDA_ENABLED', true)
export const HELIUS_ENABLED = envBool('HELIUS_ENABLED', false)
export const HELIUS_HOLDER_MAX_PAGES = envNumber('HELIUS_HOLDER_MAX_PAGES', 5)

// ── Misc (still referenced by current ultra-simple scanner) ──────
export const DEEP_CHECK_DELAY_MS = envNumber('DEEP_CHECK_DELAY_MS', 800)
export const CANDIDATE_DEDUP_HOURS = envNumber('CANDIDATE_DEDUP_HOURS', 1)
export const OOR_RECHECK_HOURS = envNumber('OOR_RECHECK_HOURS', 24)

// Cap on how many candidates we will deep-check per scanner tick.
export const MAX_FRESH_DEEP_CHECKS = envNumber('MAX_FRESH_DEEP_CHECKS', 12)

// ── Current activity model (real documented fields from /pools + derivations) ──
// Server-pushed via filter_by on the list call (per revised spec):
//   tvl >= MIN_TVL_USD && fee_24h >= MIN_FEE_24H && fee_tvl_ratio_24h >= MIN_FEE_TVL_RATIO_24H
export const MIN_TVL_USD = envNumber('MIN_TVL_USD', 500)
export const MIN_FEE_24H = envNumber('MIN_FEE_24H', 5)
export const MIN_FEE_TVL_RATIO_24H = envNumber('MIN_FEE_TVL_RATIO_24H', 0.005) // 0.5%

// Client-side (in applyJsPreFilter) after the server list + sort_by=fee_tvl_ratio_1h:desc
export const MIN_POOL_AGE_HOURS = envNumber('MIN_POOL_AGE_HOURS', 2)

// Derived proxies (client, on the small result set from the yield-sorted list)
export const MIN_IMPLIED_ACTIVE_TVL = envNumber('MIN_IMPLIED_ACTIVE_TVL', 330) // volume_1h / fee_pct
export const MAX_IMPLIED_ACTIVE_TVL = envNumber('MAX_IMPLIED_ACTIVE_TVL', 750000)

// LP count (expensive, via getProgramAccounts on survivors only)
export const MIN_LP_COUNT = envNumber('MIN_LP_COUNT', 3)

// Broad window for the activity model so that pools >=2h old with real sustained yield can be discovered.
export const ACTIVITY_MAX_POOL_AGE_MINUTES = envNumber(
  'ACTIVITY_MAX_POOL_AGE_MINUTES',
  72 * 60 // 72 hours default for activity scan
)

// Legacy name still imported/re-exported by deep-checker.ts (for scanner.ts compat).
// Use ACTIVITY_MAX_POOL_AGE_MINUTES for the broad activity window in new code.
export const MAX_POOL_AGE_MINUTES = ACTIVITY_MAX_POOL_AGE_MINUTES;

// ── LP Position Exit Rules (ultra-minimal model) ──
// 48h dry-run starting point (2026-06). Tune after observing real Fee/TVL decay curves + net PnL behavior.
// Primary signal: pool-level 24h Fee/TVL efficiency sampled over rolling 4h window.
export const LP_FEE_TVL_EXIT_THRESHOLD = envNumber('LP_FEE_TVL_EXIT_THRESHOLD', 0.75)     // last-4h avg 24h Fee/TVL % below this → exit (e.g. 0.75 = 0.75%)
export const LP_OOR_EXIT_MINUTES       = envNumber('LP_OOR_EXIT_MINUTES', 45)             // minutes out of range before exit
export const LP_NET_LOSS_SL_PCT        = envNumber('LP_NET_LOSS_SL_PCT', -30)             // net PnL % (price move + all fees) stop-loss
export const LP_NET_LOSS_SL_MIN_AGE_MIN = envNumber('LP_NET_LOSS_SL_MIN_AGE_MIN', 20)     // minutes position must be open before net-PnL SL can fire
export const LP_MAX_DURATION_HOURS     = envNumber('LP_MAX_DURATION_HOURS', 1)           // hard safety cap regardless of other signals (1h for fresh volatile memes — out after 60m max, other exit rules can fire earlier)
export const LP_FEE_TVL_SAMPLE_WINDOW_H = envNumber('LP_FEE_TVL_SAMPLE_WINDOW_H', 4)      // rolling window for avg calculation (hours)

// Pre-open quality gate: max allowed deviation between Meteora pool price and external market price (e.g. 0.05 = 5%).
// Pools with large deviation often have misaligned active bin, leading to bad IL/OOR right after opening.
export const MAX_POOL_PRICE_DEVIATION = envNumber('MAX_POOL_PRICE_DEVIATION', 0.05)

// ── Deep survivor scoring (post-gate ranking for open priority) ──
// Weights and cap are env-overridable for tuning.
// feeTvlRatio_1h gets the highest weight because recent fee velocity is the strongest signal for fresh hot pools.
export const LP_SCORE_FEE_TVL_1H_WEIGHT = envNumber('LP_SCORE_FEE_TVL_1H_WEIGHT', 0.5)
export const LP_SCORE_FEE_TVL_24H_WEIGHT = envNumber('LP_SCORE_FEE_TVL_24H_WEIGHT', 0.3)
export const LP_SCORE_LP_COUNT_WEIGHT  = envNumber('LP_SCORE_LP_COUNT_WEIGHT', 0.2)
export const LP_SCORE_LP_CAP           = envNumber('LP_SCORE_LP_CAP', 20)

// Primary logic uses real /pools fields + derivations (see README).
// Bin range is the exact desired -50%/+100% (rounded to bin boundaries); gate ensures zero bin-array cost.
