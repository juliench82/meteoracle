import type { Strategy } from '@/lib/types'

/**
 * Moonboy — casino spot-buy for freshly graduated / just-created tokens.
 *
 * Not an LP position. We buy $MOONBOY_BUY_USD of the token via Jupiter
 * the moment the scanner sees it, then hold until price doubles (+100%)
 * or we hit the stop-loss (-50%) / max duration (6 h).
 *
 * The strategy object here is used only for filter matching — the
 * actual buy/sell is handled by bot/moonboy-executor.ts.
 */
export const moonboyStrategy: Strategy = {
  id: 'moonboy',
  name: 'Moonboy',
  description: 'Spot buy $10 on early tokens, sell at 2x or −50%.',
  enabled: process.env.MOONBOY_ENABLED !== 'false',
  filters: {
    // Age is the only real gate — must be fresh (<= 90 min)
    maxAgeHours:        1.5,
    minMcUsd:           0,
    maxMcUsd:           Number.MAX_SAFE_INTEGER,
    minVolume24h:       0,
    minLiquidityUsd:    500,
    maxTopHolderPct:    80,
    minHolderCount:     0,
    minRugcheckScore:   0,
    requireSocialSignal: false,
    minFeeTvl24hPct:    0,
  },
  // position block is unused for spot buys but required by the Strategy type
  position: {
    binStep:          0,
    rangeDownPct:     0,
    rangeUpPct:       0,
    distributionType: 'spot',
    solBias:          1,
  },
  exits: {
    takeProfitPct:       100,   // sell at 2x
    stopLossPct:         -50,   // stop at −50%
    outOfRangeMinutes:   0,
    maxDurationHours:    6,
    claimFeesBeforeClose: false,
    minFeesToClaim:      0,
  },
}
