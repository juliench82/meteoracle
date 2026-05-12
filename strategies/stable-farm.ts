import type { Strategy } from '@/lib/types'

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const stableFarmStrategy: Strategy = {
  id: 'stable-farm',
  version: 'v1.1',
  name: 'Stable Farm',
  description: 'Known stablecoin pairs. Tight bid-ask distribution, low tolerance for depeg.',
  enabled: true,
  filters: {
    minMcUsd: 0,
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 0,
    minLiquidityUsd: envNumber('STABLE_FARM_MIN_LIQUIDITY_USD', 50_000),
    maxTopHolderPct: 100,
    minHolderCount: 0,
    maxAgeHours: Number.MAX_SAFE_INTEGER,
    minRugcheckScore: 0,
    requireSocialSignal: false,
    minFeeTvl24hPct: 0,
  },
  position: {
    binStep: envNumber('STABLE_FARM_BIN_STEP', 1),
    rangeDownPct: envNumber('STABLE_FARM_RANGE_DOWN_PCT', -2),
    rangeUpPct: envNumber('STABLE_FARM_RANGE_UP_PCT', 2),
    distributionType: 'bid-ask',
    solBias: 0,
  },
  exits: {
    stopLossPct: envNumber('STABLE_FARM_STOP_LOSS_PCT', -5),
    takeProfitPct: envNumber('STABLE_FARM_TAKE_PROFIT_PCT', 10),
    outOfRangeMinutes: envNumber('STABLE_FARM_OOR_MINUTES', 10),
    maxDurationHours: envNumber('STABLE_FARM_MAX_DURATION_HOURS', 168),
    claimFeesBeforeClose: true,
    minFeesToClaim: envNumber('STABLE_FARM_MIN_FEES_TO_CLAIM', 0.0001),
    // IL exit: 3% IL on a stable pair = depeg event. Exit immediately.
    maxIlPct: envNumber('STABLE_FARM_MAX_IL_PCT', -3),
  },
}
