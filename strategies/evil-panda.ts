import type { Strategy } from '@/lib/types'

/**
 * Evil Panda Strategy
 * Wide-range (−70% / +180%) bid-ask fee farming on fresh low-cap memecoins.
 * Bid-ask distribution maximises fees on pumps — SOL auto-sells into token on moons.
 * Single-sided SOL deposit below current price.
 *
 * Tier: MEME_SHITCOIN — age < 48h OR mc < $3M OR vol1h/liq > 5% OR top10holders > 35%
 * Profile: HIGH risk / fee-only yield / SHORT-MEDIUM duration
 *
 * Credit: @tendorian9 on X
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Bid-ask distribution, 100% single-sided SOL. ' +
    '−70% / +180% range captures dumps and moons, auto-sells SOL into token on pumps. ' +
    'Exits when volume dies or profit target hits.',
  enabled: true,

  filters: {
    minMcUsd:             50_000,
    maxMcUsd:          5_000_000,
    minVolume24h:         40_000,
    minLiquidityUsd:      20_000,
    maxTopHolderPct:          25,
    minHolderCount:          100,  // lowered from 200 — fresh memes won't have 200 holders fast
    maxAgeHours:             120,
    minRugcheckScore:         25,  // lowered from 40 — Solana meme tokens routinely score 15-30
    requireSocialSignal:   false,
    minFeeTvl24hPct:          15,  // lowered from 35 — 35% was unrealistic as a floor
  },

  position: {
    binStep:              100,
    rangeDownPct:         -70,   // stays in range on hard dumps
    rangeUpPct:           180,   // auto-sells SOL into token on moons
    distributionType: 'bid-ask', // fees explode on pumps
    solBias:              1.0,   // 100% single-sided SOL
    // maxSolPerPosition driven by MAX_SOL_PER_POSITION env var
  },

  exits: {
    stopLossPct:           -90,
    takeProfitPct:          60,  // withdraw + redeposit on big winner
    outOfRangeMinutes:      60,  // tightened from 120
    maxDurationHours:      168,  // 7 days
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.001,
  },
}
