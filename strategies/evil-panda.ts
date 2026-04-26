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
 * - stopLoss    : −90% price AND fee yield < 5% of deployed (don't stop a fee machine)
 * - takeProfit  : +150% price — raised from 60% to avoid closing fee earners early
 * - OOR         : 60 min out of range (earning nothing)
 * - maxDuration : 336h (14 days) — extended from 7d; fee machines should run
 * - feeYieldExitPct   : close early if fees > 25% of deployed within first 12h (bank the moonshot)
 * - feeYieldExtendPct : reset max-duration clock if fees > 15%/day (keep winners running)
 */
export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  name: 'Evil Panda',
  description:
    'Wide-range memecoin fee farming. Bid-ask distribution, 100% single-sided SOL. ' +
    '−70% / +180% range captures dumps and moons, auto-sells SOL into token on pumps. ' +
    'Exits when volume dies or profit target hits. Fee-yield-aware exits keep winners running.',
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
    stopLossPct:           -90,   // rug guard only — won't fire unless near-zero collapse
    takeProfitPct:         150,   // raised from 60 — don't close a fee machine on a modest pump
    outOfRangeMinutes:      60,   // OOR = earning nothing, close promptly
    maxDurationHours:      336,   // 14 days — extended from 7d; fee-yield extension applies
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.001,
    // Fee-yield extensions (read by checkPosition in monitor.ts):
    // feeYieldExitPct:     25    — close early if fees > 25% of deployed in first 12h
    // feeYieldExtendPct:   15    — reset duration clock if fees > 15%/day (keep winners running)
  },
}
