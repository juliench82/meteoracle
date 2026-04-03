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
    minMcUsd:          200_000,   // $200K min market cap
    maxMcUsd:       50_000_000,   // $50M max
    minVolume24h:       40_000,   // $40K min 24h volume (testing)
    minLiquidityUsd:    20_000,   // $20K min liquidity (testing)
    maxTopHolderPct:        25,   // top holder ≤ 25% of supply (testing)
    minHolderCount:        200,   // at least 200 holders (testing)
    maxAgeHours:           168,   // token ≤ 7 days old
    minRugcheckScore:       30,   // rugcheck safety score (testing)
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
