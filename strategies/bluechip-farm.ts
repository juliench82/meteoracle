import type { Strategy } from '@/lib/types'

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const bluechipFarmStrategy: Strategy = {
  id: 'bluechip-farm',
  version: 'v1.1',
  name: 'Bluechip Farm',
  description: 'Large-cap, long-lived, USDC/USDT-quoted pools. Moderate range, medium duration.',
  enabled: true,
  filters: {
    minMcUsd: envNumber('BLUECHIP_FARM_MIN_MC_USD', 100_000_000),
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: envNumber('BLUECHIP_FARM_MIN_VOLUME_24H', 500_000),
    minLiquidityUsd: envNumber('BLUECHIP_FARM_MIN_LIQUIDITY_USD', 100_000),
    maxTopHolderPct: envNumber('BLUECHIP_FARM_MAX_TOP_HOLDER_PCT', 25),
    minHolderCount: envNumber('BLUECHIP_FARM_MIN_HOLDER_COUNT', 5_000),
    maxAgeHours: Number.MAX_SAFE_INTEGER,
    minRugcheckScore: 0,
    requireSocialSignal: false,
    minFeeTvl24hPct: 0,
    requiredQuoteMints: [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // USDC.e
    ],
  },
  position: {
    binStep: envNumber('BLUECHIP_FARM_BIN_STEP', 20),
    rangeDownPct: envNumber('BLUECHIP_FARM_RANGE_DOWN_PCT', -15),
    rangeUpPct: envNumber('BLUECHIP_FARM_RANGE_UP_PCT', 20),
    distributionType: 'curve',
    solBias: 0,
  },
  exits: {
    stopLossPct: envNumber('BLUECHIP_FARM_STOP_LOSS_PCT', -20),
    takeProfitPct: envNumber('BLUECHIP_FARM_TAKE_PROFIT_PCT', 40),
    outOfRangeMinutes: envNumber('BLUECHIP_FARM_OOR_MINUTES', 60),
    maxDurationHours: envNumber('BLUECHIP_FARM_MAX_DURATION_HOURS', 720),
    claimFeesBeforeClose: true,
    minFeesToClaim: envNumber('BLUECHIP_FARM_MIN_FEES_TO_CLAIM', 0.01),
    // IL exits disabled for bluechip-farm — long-duration, fee income justifies holding.
    // Enable via BLUECHIP_FARM_MAX_IL_PCT env if needed (e.g. -20).
    maxIlPct: process.env.BLUECHIP_FARM_MAX_IL_PCT !== undefined
      ? envNumber('BLUECHIP_FARM_MAX_IL_PCT', -20)
      : undefined,
  },
}
