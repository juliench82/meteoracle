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
    minVolume24h:       60_000,   // $60K min 24h volume
    minLiquidityUsd:    50_000,   // $50K min liquidity
    maxTopHolderPct:        15,   // top holder ≤ 15% of supply
    minHolderCount:        350,   // at least 350 holders
    maxAgeHours:            72,   // token ≤ 3 days old
    minRugcheckScore:       55,   // rugcheck safety score (0–100, 100=safest)
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
