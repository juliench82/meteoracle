export type PositionStatus =
  | 'active'
  | 'out_of_range'
  | 'closed'
  | 'error'
  | 'pending_retry'
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
  feesEarnedSol: number
  status: PositionStatus
  inRange: boolean
  openedAt: string
  closedAt?: string
  pnlSol?: number
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
  liquidityUsd: number
  topHolderPct: number
  holderCount: number
  ageHours: number
  rugcheckScore: number
  priceUsd: number
  poolAddress: string
  dexId: string
  /** 24h fees / TVL expressed as a percentage, e.g. 131.35 means 131.35% */
  feeTvl24hPct: number
  /** pump.fun bonding curve fill %, 0–100. undefined = not a pump.fun token or fetch failed. */
  bondingCurvePct?: number
  /** Quote token mint address of the selected pool (e.g. WSOL, USDC, USDT). */
  quoteTokenMint?: string
  /** Pool bin step (e.g. 20, 50, 100, 200). Used to enforce minBinStep strategy filter. */
  binStep?: number
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
   * If set, the pool’s quote token mint must be one of these addresses.
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
  maxSolPerPosition?: number   // optional — overridden by MAX_SOL_PER_POSITION env var
}

export interface ExitRules {
  stopLossPct: number
  takeProfitPct: number
  outOfRangeMinutes: number
  maxDurationHours: number
  claimFeesBeforeClose: boolean
  minFeesToClaim: number
  /**
   * Exit if fees earned reach this % of deployed SOL — even if price is down.
   * This is the primary safety net: lock in fee gains before IL worsens.
   * Optional — omit to disable.
   */
  minFeeYieldToExit?: number
  /**
   * If fees earned exceed this % of deployed SOL within the first 12h → early exit.
   * Captures moonshot fee windfalls before volume dies. Optional — omit to disable.
   */
  feeYieldExitPct?: number
  /**
   * If daily fee yield (annualised from actual age) meets or exceeds this % →
   * extend maxDurationHours by feeYieldExtensionHours per threshold hit.
   * Keeps high-yield winners running. Optional — omit to disable.
   */
  feeYieldExtendPct?: number
  /**
   * Hours added to maxDurationHours per feeYieldExtendPct threshold hit.
   * Defaults to 24 if feeYieldExtendPct is set but this is omitted.
   */
  feeYieldExtensionHours?: number
}

export interface Strategy {
  id: string
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
