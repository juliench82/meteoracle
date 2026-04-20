import type { Strategy } from '@/lib/types'

/**
 * Bluechip Farm Strategy
 * Targets established large-cap tokens paired with SOL/USDC/USDT.
 * Wider range than stable-farm to tolerate real directional movement.
 */
export const bluechipFarmStrategy: Strategy = {
  id: 'bluechip-farm',
  name: 'Bluechip Farm',
  description:
    'Fee farming on established large-cap token pairs. Targets long-lived, broadly-held assets with sufficient liquidity and steady volume. Moderate range, medium duration.',
  enabled: true,

  filters: {
    minMcUsd: 100_000_000,
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 100_000,
    minLiquidityUsd: 100_000,
    maxTopHolderPct: 25,
    minHolderCount: 5_000,
    maxAgeHours: 999999,
    minRugcheckScore: 40,
    requireSocialSignal: false,
    minFeeTvl24hPct: 3,
  },

  position: {
    binStep: 10,
    rangeDownPct: -15,
    rangeUpPct: 15,
    distributionType: 'curve',
    solBias: 0.5,
    maxSolPerPosition: 0.5,
  },

  exits: {
    stopLossPct: -20,
    takeProfitPct: 200,
    outOfRangeMinutes: 60,
    maxDurationHours: 72,
    claimFeesBeforeClose: true,
    minFeesToClaim: 0.002,
  },
}
