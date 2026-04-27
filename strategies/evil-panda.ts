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
 * Previous range −70% / +180% = 250 bins → always OOM-rejected at simulation.
 *
 * Exit logic (fee-yield-aware):
 * - stopLoss             : −50% price
 * - takeProfit           : +40% price — realistic exit, not waiting for a moon
 * - OOR                  : 45 min out of range (earning nothing)
 * - maxDuration          : 72h (3 days)
 * - minFeeYieldToExit    : exit if fees reach 10% of deployed (safety net even with IL)
 * - feeYieldExitPct      : close early if fees > 25% of deployed within first 12h
 * - feeYieldExtendPct    : if daily yield >= 12% → add feeYieldExtensionHours per threshold hit
 * - feeYieldExtensionHours: 36h added per 12% daily yield threshold
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Bid-ask distribution, 100% single-sided SOL. ' +
    '−50% / +100% range captures dumps and moons, auto-sells SOL into token on pumps. ' +
    'Fee-yield-aware exits — bank fees before IL compounds.',
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
    rangeDownPct:         -50,   // was -70 → 70 bins; now 50 bins
    rangeUpPct:           100,   // was +180 → 180 bins; now 100 bins — total 150 bins
    distributionType: 'bid-ask',
    solBias:              1.0,
  },

  exits: {
    stopLossPct:              -50,   // aligned with rangeDownPct
    takeProfitPct:             40,
    outOfRangeMinutes:         45,
    maxDurationHours:          72,
    claimFeesBeforeClose:    true,
    minFeesToClaim:          0.001,

    // === Fee-based exits (key safety net) ===
    minFeeYieldToExit:         10,
    feeYieldExitPct:           25,
    feeYieldExtendPct:         12,
    feeYieldExtensionHours:    36,
  },
}
