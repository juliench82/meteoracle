import type { Strategy } from '@/lib/types'

// Stable quote mint addresses — pool MUST be quoted in one of these.
// Any SOL-paired token, no matter how large its MC, is NOT a bluechip.
const USDC  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT  = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
const USDCe = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo' // Wormhole USDC.e

/**
 * Bluechip Farm Strategy
 * Targets established large-cap tokens paired with USDC/USDT — NOT SOL.
 * A SOL-paired shitcoin with $100M MC is still a shitcoin.
 * Wider range than stable-farm to tolerate real directional movement.
 */
export const bluechipFarmStrategy: Strategy = {
  id: 'bluechip-farm',
  name: 'Bluechip Farm',
  description:
    'Fee farming on established large-cap token pairs quoted in USDC or USDT only. ' +
    'SOL-paired tokens are excluded regardless of market cap. ' +
    'Targets long-lived, broadly-held assets with sufficient liquidity and steady volume. ' +
    'Moderate range, medium duration.',
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
    // HARD GATE: pool quote token must be a stable — USDC, USDT, or USDC.e.
    requiredQuoteMints: [USDC, USDT, USDCe],
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
