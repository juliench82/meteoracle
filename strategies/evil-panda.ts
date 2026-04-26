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
 *
 * Exit logic (fee-yield-aware):
 * - stopLoss             : −90% price — rug guard only
 * - takeProfit           : +150% price — raised from 60%; don’t close a fee machine on a modest pump
 * - OOR                  : 60 min out of range (earning nothing)
 * - maxDuration          : 336h (14 days) base; extended dynamically by fee yield
 * - feeYieldExitPct      : close early if fees > 25% of deployed within first 12h (bank the moonshot)
 * - feeYieldExtendPct    : if daily yield ≥ 15% → add feeYieldExtensionHours per threshold hit
 * - feeYieldExtensionHours: 48h added per 15% daily yield threshold (keep winners running)
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Bid-ask distribution, 100% single-sided SOL. ' +
    '−70% / +180% range captures dumps and moons, auto-sells SOL into token on pumps. ' +
    'Fee-yield-aware exits keep winners running.',
  enabled: true,

  filters: {
    minMcUsd:             50_000,
    maxMcUsd:         10_000_000,
    minVolume24h:         40_000,
    minLiquidityUsd:      20_000,
    maxTopHolderPct:         100,
    minHolderCount:          100,
    maxAgeHours:             720,
    minRugcheckScore:          0,
    requireSocialSignal:   false,
    minFeeTvl24hPct:          15,
  },

  position: {
    binStep:              100,
    rangeDownPct:         -70,
    rangeUpPct:           180,
    distributionType: 'bid-ask',
    solBias:              1.0,
  },

  exits: {
    stopLossPct:              -90,   // rug guard only
    takeProfitPct:            150,   // raised from 60
    outOfRangeMinutes:         60,   // OOR = earning nothing
    maxDurationHours:         336,   // 14 days base — extended dynamically
    claimFeesBeforeClose:    true,
    minFeesToClaim:          0.001,
    feeYieldExitPct:           25,   // early exit if fees > 25% of deployed in first 12h
    feeYieldExtendPct:         15,   // extend duration if daily yield ≥ 15%
    feeYieldExtensionHours:    48,   // +48h per 15% daily yield threshold hit
  },
}
