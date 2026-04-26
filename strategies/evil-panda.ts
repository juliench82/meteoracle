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
 * - stopLoss             : −70% price — tightened from -90%
 * - takeProfit           : +40% price — realistic exit, not waiting for a moon
 * - OOR                  : 45 min out of range (earning nothing)
 * - maxDuration          : 72h (3 days) — tightened from 14 days
 * - minFeeYieldToExit    : exit if fees reach 10% of deployed (safety net even with IL)
 * - feeYieldExitPct      : close early if fees > 25% of deployed within first 12h
 * - feeYieldExtendPct    : if daily yield >= 12% → add feeYieldExtensionHours per threshold hit
 * - feeYieldExtensionHours: 36h added per 12% daily yield threshold (shorter extension)
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Bid-ask distribution, 100% single-sided SOL. ' +
    '−70% / +180% range captures dumps and moons, auto-sells SOL into token on pumps. ' +
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
    rangeDownPct:         -70,
    rangeUpPct:           180,
    distributionType: 'bid-ask',
    solBias:              1.0,
  },

  exits: {
    stopLossPct:              -70,   // tightened from -90%
    takeProfitPct:             40,   // realistic — don't wait for a moon
    outOfRangeMinutes:         45,   // tightened from 60
    maxDurationHours:          72,   // 3 days instead of 14
    claimFeesBeforeClose:    true,
    minFeesToClaim:          0.001,

    // === Fee-based exits (key safety net) ===
    minFeeYieldToExit:         10,   // exit if fees reach 10% of deployed even if price is down
    feeYieldExitPct:           25,   // early exit if fees > 25% of deployed in first 12h
    feeYieldExtendPct:         12,   // extend if daily yield >= 12% (down from 15%)
    feeYieldExtensionHours:    36,   // +36h per threshold hit (down from 48h)
  },
}
