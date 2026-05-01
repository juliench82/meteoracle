import type { Strategy } from '@/lib/types'

/**
 * Evil Panda Strategy
 * Wide-range (−50% / +100%) bid-ask fee farming on fresh low-cap memecoins.
 * Bid-ask distribution maximises fees on pumps — SOL auto-sells into token on moons.
 * Single-sided SOL deposit below current price.
 *
 * Tier: MEME_SHITCOIN — age < 48h OR mc < $3M OR vol1h/liq > 5% OR top10holders > 35%
 * Profile: HIGH risk / fee-only yield / SHORT-MEDIUM duration
 *
 * Credit: @tendorian9 on X
 *
 * Range math (binStep=100 → 1% per bin):
 *   rangeDown = 50 bins (−50%)
 *   rangeUp   = 100 bins (+100%)
 *   total     = 150 bins  ← well within MAX_BINS_BY_STRATEGY[evil-panda]=200
 *
 * minBinStep=80: rejects stable/USDC pools (binStep 1–20) that would produce
 * 750+ bins for this range width and always hit the OOM/bin-cap guard.
 *
 * Exit logic:
 * - stopLoss    : −50% price
 * - takeProfit  : +40% price
 * - OOR         : 120 min out of range (earning nothing)
 * - maxDuration : 72h (3 days) hard stop
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Bid-ask distribution, 100% single-sided SOL. ' +
    '−50% / +100% range captures dumps and moons, auto-sells SOL into token on pumps.',
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
    minBinStep:               80,
  },

  position: {
    binStep:              100,
    rangeDownPct:         -50,
    rangeUpPct:           100,
    distributionType: 'bid-ask',
    solBias:              1.0,
  },

  exits: {
    stopLossPct:              -50,
    takeProfitPct:             40,
    outOfRangeMinutes:        120,
    maxDurationHours:          72,
    claimFeesBeforeClose:    true,
    minFeesToClaim:          0.001,
  },
}
