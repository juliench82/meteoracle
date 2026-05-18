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

export interface Position {
  id: string
  tokenSymbol: string
  tokenAddress: string
  poolAddress: string
  strategyId: string
  binRangeLower: number
  binRangeUpper: number
  entryPrice: number
  currentPrice?: number
  solDeposited: number
  /** Claimable fees in USD — live from Meteora API, mirrors Meteora UI. */
  claimableFeesUsd?: number
  /** Current position value in USD — live from Meteora API (token amounts × price). */
  positionValueUsd?: number
  /** Realised PnL in USD — snapshot captured from Meteora at close time only. */
  realizedPnlUsd?: number
  /** PnL as a percentage — written by monitor on every tick, drives SL/TP logic. */
  pnlPct?: number
  status: PositionStatus
  inRange: boolean
  openedAt: string
  closedAt?: string
  metadata?: Record<string, unknown>
}

export interface Candidate {
  id: string
  tokenAddress: string
  symbol: string
  score: number
  strategyMatched: string
  mcAtScan: number
  volume24h: number
  holderCount: number
  rugcheckScore?: number
  topHolderPct?: number
  scannedAt: string
}

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
  /** 1h fees / TVL expressed as a percentage. Used by scanner v2 freshness scoring. */
  feeTvl1hPct?: number
  /** 5m fees / TVL expressed as a percentage. Used by scanner v2 freshness scoring. */
  feeTvl5mPct?: number
  /** 1h volume / TVL ratio, e.g. 0.8 means 80% of TVL traded in the last hour. */
  volumeTvl1hRatio?: number
  /** 5m volume annualized to 1h divided by observed 1h volume. >1 means accelerating. */
  volumeGrowth1h?: number
  /** Meteora-native pre-Helius momentum score used to rank deep checks. */
  momentumScore?: number
  /** pump.fun bonding curve fill %, 0–100. undefined = not a pump.fun token or fetch failed. */
  bondingCurvePct?: number
  /** Quote token mint address of the selected pool (e.g. WSOL, USDC, USDT). */
  quoteTokenMint?: string
  /** Pool bin step (e.g. 20, 50, 100, 200). Used to enforce minBinStep strategy filter. */
  binStep?: number
  /** Score assigned by the scorer — set by scanner before passing to executor. */
  score?: number
  /** Detected launchpad for the token (pumpfun tokens may need special manual open path) */
  launchpadSource?: 'pumpfun' | 'moonshot' | 'meteora'
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
  requireSocialSignal: boolean
  /** Minimum 24h Fee/TVL % required to enter this pool. Strategy-dependent. */
  minFeeTvl24hPct: number
  /**
   * If set, reject pools whose bin step is below this value.
   * Evil Panda uses 80 to block stable/USDC pools (binStep 1–20) that produce
   * 750+ bins for a −50%/+100% range, always hitting the OOM/bin-cap guard.
   */
  minBinStep?: number
  /**
   * If set, the pool's quote token must be one of these addresses.
   * Used by bluechip-farm to enforce USDC/USDT-only pairs.
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
  maxSolPerPosition?: number
}

export interface ExitRules {
  stopLossPct: number
  takeProfitPct: number
  outOfRangeMinutes: number
  maxDurationHours: number
  claimFeesBeforeClose: boolean
  minFeesToClaim: number
  /**
   * Maximum impermanent loss % before forcing exit. Negative number, e.g. -15 means
   * exit when IL reaches -15%. Only evaluated for DLMM positions. Leave undefined to
   * disable IL-based exits for a strategy (e.g. bluechip-farm).
   *
   * Formula: IL% = (2√k / (1+k) − 1) × 100  where k = currentPrice / entryPrice
   *
   * Suggested defaults:
   *   evil-panda:   -15  (wide range; IL at 15% ≈ 2.3× price move)
   *   scalp-spike:  -10  (tight range; spike scenario — exit fast)
   *   stable-farm:   -3  (any 3% IL on a stable pair is a depeg event)
   *   bluechip-farm: undefined (disabled — long-duration, fee income justifies holding)
   */
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

export interface BotLog {
  id: string
  level: 'info' | 'warn' | 'error'
  event: string
  payload?: Record<string, unknown>
  createdAt: string
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

// ── DAMM v2 — isolated type definitions ────────────────────────────────────────────
// These are used by DAMM market-edge and DBC migration entries.
// No existing DLMM code references these types.

export type DammPositionStrategyId = 'damm-edge' | 'damm-migration'

/**
 * Parameters needed to open a DAMM v2 position.
 * Built by evaluateDammEdge() or the DBC graduation watcher and consumed by openDammPosition().
 * For damm-edge scanner opens, poolAddress must be a verified DAMM v2 pool, not the source DLMM pool.
 */
export interface DammPositionParams {
  tokenAddress: string
  poolAddress: string
  /** SOL amount to deposit (conservative — we are testing the edge). */
  solAmount: number
  symbol: string
  /** Pool age in minutes at time of decision. */
  ageMinutes: number
  /** 24h fee/TVL % at time of decision (for logging / audit). */
  feeTvl24hPct: number
  /** Pool liquidity in USD at time of decision (for logging / audit). */
  liquidityUsd: number
  /** pump.fun bonding curve fill % at time of decision (0–100). Optional. */
  bondingCurvePct?: number
  strategyId?: DammPositionStrategyId
  positionType?: DammPositionStrategyId
  metadata?: Record<string, unknown>
}

/**
 * Return value of evaluateDammEdge().
 * Tells the scanner whether to open a DAMM v2 position and with what params.
 */
export interface DammEdgeDecision {
  shouldUseDamm: boolean
  /** Human-readable reason for accept or reject — always present for logging. */
  reason: string
  /** Only present when shouldUseDamm === true. */
  params?: DammPositionParams
}
