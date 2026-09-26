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

// Derived proxies (client, on the small result set from the yield-sorted list).
//
// IMPLIED ACTIVE TVL is now the pool's REAL tvl in true USD, not a fee-tier
// proxy: bot/scanner/pool-metrics.ts:getImpliedActiveTvl derives it as
//   fees_1h / (fee_tvl_ratio_1h / 100)  ==  fees_1h * 100 / fee_tvl_ratio_1h
// which reproduces the API's own `tvl` exactly (398/398 recorded candidate
// pools over two live captures, max abs diff 2.3e-10).
//
// WINDOW RE-DERIVED 2026-09-25 (was 330 / 750000 — the unit scale of the old
// `volume_1h / base_fee_pct` proxy, which was ~1000x off live and wrongly
// rejected candidate pools as "too active": 40/198 and 43/200 on the two
// recorded captures — audit finding M6).
// Source: the recorded live distributions of the CANDIDATE SET (every pool the
// server list call returned, before the client JS pre-filter), anonymised
// fixture committed at tests/fixtures/implied-active-tvl-candidate-pools.json
// (n=398, two captures, true USD):
//   C1 n=198: min 505.44  p10 1089.23  median 7959.64  p90 73932.28  max 339001.97
//   C2 n=200: min 513.84  p10  990.01  median 8042.58  p90 73506.58  max 1614887.72
// MIN = floor of the recorded candidate minimum (505.44 -> 505): below the
//   smallest real earning liquidity the scanner ever considered; it can only
//   refuse pools the server-side tvl>=500 filter would already have excluded.
// MAX = ceil of the recorded candidate maximum ACROSS BOTH CAPTURES
//   (1614887.718 -> 1614888): the ceiling is deliberately taken from the widest
//   recorded window, because the candidate set is the top ~200 pools by 1h
//   fee/TVL and its size range moves between windows — a ceiling derived from
//   one capture would re-introduce M6's false rejections in a wider one. With
//   the corrected metric the gate now refuses 0/398 recorded candidate pools,
//   so no pool the old proxy wrongly rejected as "too active" is rejected again.
//   It remains a pure sanity ceiling (env-overridable), not a size preference:
//   the scanner's size knobs are MIN_TVL_USD / maxLiquidityUsd.
export const MIN_IMPLIED_ACTIVE_TVL = envNumber('MIN_IMPLIED_ACTIVE_TVL', 505) // true USD (real tvl)
export const MAX_IMPLIED_ACTIVE_TVL = envNumber('MAX_IMPLIED_ACTIVE_TVL', 1614888) // true USD (real tvl)

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
// Primary signal: pool-level 24h Fee/TVL efficiency sampled over a rolling 4h window.
//
// UNIT: percent, as returned by dlmm.datapi.meteora.ag (`fee_tvl_ratio` is already
// fees/tvl*100 — see bot/scanner/pool-metrics.ts:getFeeTvlPct and the recorded fixture
// tests/fixtures/fee-tvl-selected-pools.json).
//
// DEFAULT RE-TUNED 2026-09-25 (was 0.75, which had been chosen under the wrong unit and
// therefore made rule #1 effectively dead — it only fired below 0.0075%). The new default is
// the 10th percentile (p10) of the recorded live distribution of `fee_tvl_ratio_24h` for the
// 22 pools the activity scanner actually selected on 2026-09-25 (real code path, anonymised
// fixture committed at tests/fixtures/fee-tvl-selected-pools.json):
//   n=22  min 0.5449  p5 1.0298  p10 5.5389  p25 9.4189  median 18.9664  p75 66.5012  max 354.8405
// Rationale: exit when the position pool's 24h Fee/TVL has decayed into the bottom decile of
// what the scanner would even consider — a genuine yield collapse, not noise. `p10 = 5.5389`
// rounded to 5.54. Override with LP_FEE_TVL_EXIT_THRESHOLD.
// NOTE for the entry-vs-exit invariant (lib/config-invariants.ts): this exit threshold is now
// ABOVE the historical entry floor (MIN_FEE_TVL_RATIO_24H*100 = 0.5), so the entry floor must
// be raised above it to keep the pair consistent (batch B5).
export const LP_FEE_TVL_EXIT_THRESHOLD = envNumber('LP_FEE_TVL_EXIT_THRESHOLD', 5.54)     // last-4h avg 24h Fee/TVL % below this → exit (e.g. 5.54 = 5.54%)
export const LP_OOR_EXIT_MINUTES       = envNumber('LP_OOR_EXIT_MINUTES', 45)             // minutes out of range before exit
export const LP_NET_LOSS_SL_PCT        = envNumber('LP_NET_LOSS_SL_PCT', -30)             // net PnL % (price move + all fees) stop-loss
export const LP_NET_LOSS_SL_MIN_AGE_MIN = envNumber('LP_NET_LOSS_SL_MIN_AGE_MIN', 20)     // minutes position must be open before net-PnL SL can fire
export const LP_NET_LOSS_SL_INTERIM_PCT  = envNumber('LP_NET_LOSS_SL_INTERIM_PCT', -15)    // tighter net-PnL SL active DURING the warm-up grace (before MIN_AGE_MIN); prevents >50% loss before the regular -30% SL may fire
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
