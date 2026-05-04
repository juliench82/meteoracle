import type { Strategy } from '@/lib/types'

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

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
 * - stopLoss    : −30% Meteora PnL
 * - takeProfit  : +40% Meteora PnL
 * - OOR         : 15 min out of range (give price a short recovery window)
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
    minMcUsd:             envNumber('EVIL_PANDA_MIN_MC_USD', 50_000),
    maxMcUsd:             envNumber('EVIL_PANDA_MAX_MC_USD', 10_000_000),
    minVolume24h:         envNumber('EVIL_PANDA_MIN_VOLUME_24H', 0),
    minLiquidityUsd:      envNumber('EVIL_PANDA_MIN_LIQUIDITY_USD', 20_000),
    maxTopHolderPct:      envNumber('EVIL_PANDA_MAX_TOP_HOLDER_PCT', 35),
    minHolderCount:       envNumber('EVIL_PANDA_MIN_HOLDER_COUNT', 100),
    maxAgeHours:          envNumber('EVIL_PANDA_MAX_AGE_HOURS', 2),
    minRugcheckScore:     envNumber('EVIL_PANDA_MIN_RUGCHECK_SCORE', 65),
    requireSocialSignal:   false,
    minFeeTvl24hPct:      envNumber('EVIL_PANDA_MIN_FEE_TVL_24H_PCT', 0),
    minBinStep:           envNumber('EVIL_PANDA_MIN_BIN_STEP', 80),
  },

  position: {
    binStep:              100,
    rangeDownPct:         -50,
    rangeUpPct:           100,
    distributionType: 'bid-ask',
    solBias:              1.0,
  },

  exits: {
    stopLossPct:              -30,
    takeProfitPct:             40,
    outOfRangeMinutes:         15,
    maxDurationHours:          72,
    claimFeesBeforeClose:    true,
    minFeesToClaim:          0.001,
  },
}
