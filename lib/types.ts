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
  scannedAt: string
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
  solBias: number // 0 = 50/50, 1 = 100% SOL
  maxSolPerPosition: number
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
