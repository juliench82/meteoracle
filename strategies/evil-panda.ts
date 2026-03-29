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
    minMcUsd: 200_000,      // $200K min market cap
    maxMcUsd: 50_000_000,   // $50M max (avoid overextended)
    minVolume24h: 300_000,  // $300K min 24h volume
    minLiquidityUsd: 50_000,
    maxTopHolderPct: 15,    // top holder ≤ 15% of supply
    minHolderCount: 500,
    maxAgeHours: 72,        // token ≤ 3 days old
    minRugcheckScore: 60,   // rugcheck.xyz score
    requireSocialSignal: false,
  },

  position: {
    binStep: 100,           // 100 bps — wide bins for volatile pairs
    rangeDownPct: -80,      // −80% below entry price
    rangeUpPct: 20,         // +20% above
    distributionType: 'spot',
    solBias: 0.8,           // 80% SOL-sided deposit
    maxSolPerPosition: 0.5, // override with MAX_SOL_PER_POSITION env
  },

  exits: {
    stopLossPct: -90,               // exit if down >90% from entry
    takeProfitPct: 300,             // take profit at 3x
    outOfRangeMinutes: 120,         // close if OOR for >2h
    maxDurationHours: 48,           // hard 48h limit
    claimFeesBeforeClose: true,
    minFeesToClaim: 0.001,          // only claim if >0.001 SOL fees
  },
}
