import type { Strategy } from '@/lib/types'

/**
 * Scalp Spike Strategy
 * Tight-range fee farming on ESTABLISHED memecoins experiencing a volume spike.
 * NOT for fresh launches or shitcoins — those go to Evil Panda.
 * Requires token to be at least 72h old with $5M+ MC to filter pump-and-dumps.
 *
 * Tier: MEMECOIN — MC $5M–$50M, age >= 72h
 * Profile: HIGH risk / HIGH reward / SHORT duration
 */
export const scalpSpikeStrategy: Strategy = {
  id: 'scalp-spike',
  name: 'Scalp Spike',
  description:
    'Tight-range fee farming on volume-spiking established memecoins. Requires 72h+ age and $5M+ MC to rule out pump-and-dump launches. Deploys a ±20% range, exits within hours.',
  enabled: true,

  filters: {
    minMcUsd:          5_000_000,
    maxMcUsd:         50_000_000,
    minVolume24h:        200_000,
    minLiquidityUsd:      30_000,
    maxTopHolderPct:         100,
    minHolderCount:          300,
    maxAgeHours:             120,
    minRugcheckScore:         65,
    requireSocialSignal:   false,
    minFeeTvl24hPct:          15,
  },

  position: {
    binStep:               50,
    rangeDownPct:         -20,
    rangeUpPct:            20,
    distributionType:  'spot',
    solBias:              0.6,
  },

  exits: {
    stopLossPct:           -30,
    takeProfitPct:         100,
    outOfRangeMinutes:      30,
    maxDurationHours:       12,
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.0005,
  },
}
