import type { Strategy } from '@/lib/types'

/**
 * Evil Panda Strategy
 * Wide-range (−80% to +20%) fee farming on fresh low-cap memecoins.
 * Assumes the token WILL dump. Earns fees as price falls through the range.
 * Single-sided SOL deposit below current price.
 *
 * Tier: SHITCOIN — MC < $5M, age < 120h
 * Profile: HIGH risk / fee-only yield / SHORT-MEDIUM duration
 *
 * Credit: @tendorian9 on X
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Deploys single-sided SOL into −80% to +20% ranges on fresh low-cap pairs. Holds through the dump, earns fees, exits when volume dies.',
  enabled: true,

  filters: {
    minMcUsd:             50_000,
    maxMcUsd:          5_000_000, // shitcoins only — above this goes to scalp-spike or stable-farm
    minVolume24h:         40_000,
    minLiquidityUsd:      20_000,
    maxTopHolderPct:          25,
    minHolderCount:          200,
    maxAgeHours:             120, // fresh launches only
    minRugcheckScore:         40,
    requireSocialSignal:   false,
  },

  position: {
    binStep:              100,
    rangeDownPct:         -80,
    rangeUpPct:            20,
    distributionType:  'spot',
    solBias:              0.8,
    maxSolPerPosition:    0.05, // debug cap — increase once stable
  },

  exits: {
    stopLossPct:           -90, // only exit if near-zero — range is designed to hold through dumps
    takeProfitPct:         300,
    outOfRangeMinutes:     120, // 2h OOR before exit
    maxDurationHours:       48,
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.001,
  },
}
