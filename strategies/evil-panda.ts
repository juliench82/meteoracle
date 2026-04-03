import type { Strategy } from '@/lib/types'

/**
 * Evil Panda Strategy
 * Wide-range (−70% to −90%) fee farming on high-volume Solana memecoins.
 * Accumulates SOL via fees, holds through drawdowns, exits on volume death.
 * Credit: @tendorian9 on X
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Deploys single-sided SOL into −70% to −90% ranges on high-volume pairs. Holds through volatility, exits when pool volume dies.',
  enabled: true,

  filters: {
    minMcUsd:          200_000,
    maxMcUsd:       50_000_000,
    minVolume24h:       40_000,
    minLiquidityUsd:    20_000,
    maxTopHolderPct:        25,
    minHolderCount:        200,
    maxAgeHours:           120,
    minRugcheckScore:       40,   // raised from 30
    requireSocialSignal:  false,
  },

  position: {
    binStep:            100,
    rangeDownPct:       -80,
    rangeUpPct:          20,
    distributionType: 'spot',
    solBias:            0.8,
    maxSolPerPosition:  0.5,
  },

  exits: {
    stopLossPct:           -90,
    takeProfitPct:         300,
    outOfRangeMinutes:     120,
    maxDurationHours:       48,
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.001,
  },
}
