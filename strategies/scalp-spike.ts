import type { Strategy } from '@/lib/types'

/**
 * Scalp Spike Strategy
 * Targets tokens experiencing sudden volume spikes — new launches, CT pumps, or
 * trending tokens gaining momentum. Deploys a tight range centered on current price
 * to maximize fee capture during the pump window, then exits fast before reversal.
 *
 * Profile: HIGH risk / HIGH reward / SHORT duration
 */
export const scalpSpikeStrategy: Strategy = {
  id: 'scalp-spike',
  name: 'Scalp Spike',
  description:
    'Tight-range fee farming on volume-spiking tokens. Targets tokens with rapid volume growth (5x+ in 1h). Deploys a ±20% range centered on current price, claims fees aggressively, and exits within hours.',
  enabled: true,

  filters: {
    minMcUsd: 50_000,
    maxMcUsd: 5_000_000,
    minVolume24h: 500_000,
    minLiquidityUsd: 30_000,
    maxTopHolderPct: 10,
    minHolderCount: 300,
    maxAgeHours: 24,
    minRugcheckScore: 65,
    requireSocialSignal: false,
  },

  position: {
    binStep: 50,
    rangeDownPct: -20,
    rangeUpPct: 20,
    distributionType: 'spot',
    solBias: 0.6,
    maxSolPerPosition: 0.05, // reduced from 0.3 — debug/testing cap
  },

  exits: {
    stopLossPct: -30,
    takeProfitPct: 100,
    outOfRangeMinutes: 30,
    maxDurationHours: 12,
    claimFeesBeforeClose: true,
    minFeesToClaim: 0.0005,
  },
}
