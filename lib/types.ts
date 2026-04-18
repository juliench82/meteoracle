export type PositionStatus = 'active' | 'out_of_range' | 'closed' | 'error'

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
  /** pump.fun bonding curve fill %, 0–100. undefined = not a pump.fun token or fetch failed. */
  bondingCurvePct?: number
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
