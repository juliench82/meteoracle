export type PositionStatus =
  | 'active'
  | 'open'
  | 'out_of_range'
  | 'closed'
  | 'error'
  | 'pending_retry'
  | 'pending_close'
  | 'dry_run'
  | 'orphaned'
  | 'sell_failed'

export interface TokenMetrics {
  address: string
  symbol: string
  mcUsd: number
  volume24h: number
  volume1h?: number
  volume5m?: number
  liquidityUsd: number
  topHolderPct: number
  holderCount: number
  /** Whether the holderCount came from reliable Helius DAS data (true) or heuristic/fallback (false) */
  holderReliable?: boolean
  ageHours: number
  rugcheckScore: number
  priceUsd: number
  poolAddress: string
  dexId: string
  /** 24h fees / TVL expressed as a percentage, e.g. 131.35 means 131.35% */
  feeTvl24hPct: number
  /** 1h / 5m fees / TVL — kept for potential future use, currently informational. */
  feeTvl1hPct?: number
  feeTvl5mPct?: number
  /** 1h volume / TVL ratio, e.g. 0.8 means 80% of TVL traded in the last hour. */
  volumeTvl1hRatio?: number
  /** 5m volume annualized to 1h divided by observed 1h volume. >1 means accelerating. */
  volumeGrowth1h?: number
  /** momentumScore — no longer populated or used */
  momentumScore?: number
  /** pump.fun bonding curve fill %, 0–100. undefined = not a pump.fun token or fetch failed. */
  bondingCurvePct?: number
  /** Quote token mint address of the selected pool (e.g. WSOL, USDC, USDT). */
  quoteTokenMint?: string
  /** Pool bin step (e.g. 20, 50, 100, 200). Used to enforce minBinStep strategy filter. */
  binStep?: number
  /** Score assigned by the scorer — set by scanner before passing to executor. */
  score?: number
  /** Absolute price deviation between Meteora pool price and external market price (e.g. 0.07 = 7%). Populated when the pre-open deviation check runs. */
  poolPriceDeviation?: number
  /** Detected launchpad for the token (pumpfun tokens may need special manual open path) */
  launchpadSource?: 'pumpfun' | 'moonshot' | 'meteora' | 'dbc' // DBC 0.2.0+ graduates may use transfer hooks
  /** Direct link to rugcheck page (for notifications) */
  rugcheckUrl?: string
}

export interface TokenFilters {
  minMcUsd: number
  maxMcUsd: number
  minVolume24h: number
  minLiquidityUsd: number
  maxTopHolderPct: number
  minHolderCount: number
  maxAgeHours: number
  minRugcheckScore: number
  requireSocialSignal?: boolean
  /** Minimum 24h Fee/TVL % required to enter this pool. Strategy-dependent. */
  minFeeTvl24hPct?: number
  /**
   * If set, reject pools whose bin step is below this value.
   * Evil Panda uses 80 to block stable/USDC pools (binStep 1–20) that produce
   * 750+ bins for a −50%/+100% range, always hitting the OOM/bin-cap guard.
   */
  minBinStep?: number
  /**
   * If set, the pool's quote token must be one of these addresses.
   * Leave undefined to allow any quote token (SOL, USDC, USDT).
   */
  requiredQuoteMints?: string[]
}

export interface PositionConfig {
  binStep: number
  rangeDownPct: number
  rangeUpPct: number
  distributionType: 'spot' | 'curve' | 'bid-ask'
  solBias: number
}

export interface ExitRules {
  // These are snapshotted at open for compat. The actual 4-rule LP exits live in
  // strategy-config (LP_* constants) and are enforced in bot/monitor.ts.
  stopLossPct: number
  takeProfitPct: number
  outOfRangeMinutes: number
  maxDurationHours: number
  claimFeesBeforeClose: boolean
  minFeesToClaim: number
  maxIlPct?: number
}

export interface Strategy {
  id: string
  /**
   * Semantic version for this set of parameters.
   * Bump whenever filters, position config, or exit rules change.
   * Written into lp_positions.metadata.strategy_version on open — enables
   * SQL slicing of performance by param version for backtesting.
   * Format: 'v<major>.<minor>', e.g. 'v1.0', 'v1.1', 'v2.0'.
   */
  version: string
  name: string
  description: string
  filters: TokenFilters
  position: PositionConfig
  exits: ExitRules
  enabled: boolean
}

export interface DexScreenerPair {
  chainId: string
  dexId: string
  pairAddress: string
  baseToken: { address: string; name: string; symbol: string }
  quoteToken: { address: string; name: string; symbol: string }
  priceUsd?: string
  priceNative?: string
  volume?: { h24: number; h6: number; h1: number; m5: number }
  liquidity?: { usd: number; base: number; quote: number }
  marketCap?: number
  fdv?: number
  pairCreatedAt?: number
  labels?: string[]
  url?: string
}


