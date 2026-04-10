/**
 * strategies/post-grad-lp.ts
 *
 * Strategy config for post-graduation Meteora DLMM LP positions.
 * Triggered automatically when a pre-grad spot position's token graduates.
 *
 * All values are tunable via env vars — no code changes needed.
 */

export interface PostGradLpConfig {
  id: string
  lp: {
    /** % of the token bag from the spot position to put into LP (rest kept as spot) */
    bagPct:               number
    /** Bins below active bin */
    binsDown:             number
    /** Bins above active bin */
    binsUp:               number
    /** DLMM distribution type */
    distributionType:     'spot' | 'curve' | 'bid-ask'
  }
  exits: {
    /** Close LP if out-of-range for this many minutes */
    maxOorMinutes:        number
    /** Close LP after this many hours regardless */
    maxHoldHours:         number
    /** Claim + compound fees every N minutes (0 = never auto-compound) */
    feeCompoundMinutes:   number
  }
  /** Minutes to wait for Meteora pool to appear after graduation before giving up */
  poolSearchTimeoutMin:   number
  /** Seconds between Meteora pool existence retries */
  poolSearchRetrySeconds: number
}

export const POST_GRAD_LP_STRATEGY: PostGradLpConfig = {
  id: 'post-grad-lp',
  lp: {
    bagPct:           parseFloat(process.env.LP_BAG_PCT               ?? '50'),
    binsDown:         parseInt(process.env.LP_BINS_DOWN               ?? '10'),
    binsUp:           parseInt(process.env.LP_BINS_UP                 ?? '10'),
    distributionType: (process.env.LP_DISTRIBUTION_TYPE as PostGradLpConfig['lp']['distributionType']) ?? 'spot',
  },
  exits: {
    maxOorMinutes:      parseInt(process.env.LP_MAX_OOR_MINUTES        ?? '120'),
    maxHoldHours:       parseInt(process.env.LP_MAX_HOLD_HOURS         ?? '168'),  // 7 days
    feeCompoundMinutes: parseInt(process.env.LP_FEE_COMPOUND_MINUTES   ?? '0'),
  },
  poolSearchTimeoutMin:   parseInt(process.env.LP_POOL_SEARCH_TIMEOUT_MIN   ?? '60'),
  poolSearchRetrySeconds: parseInt(process.env.LP_POOL_SEARCH_RETRY_SECONDS ?? '60'),
}
