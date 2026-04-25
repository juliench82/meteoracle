import type { Strategy } from '@/lib/types'

/**
 * Scalp Spike Strategy
 *
 * Short-duration fee farming on any token (meme OR utility) experiencing a
 * real volume surge. Classification is driven entirely by the vol spike ratio
 * in classifyToken — NOT by token type or MC ceiling.
 *
 * Use cases:
 *  - Established memecoins with a narrative pump
 *  - Utility tokens (e.g. SKR) during staking-event or product-launch volume rush
 *  - Any SOL-paired token age>=48h that suddenly spikes
 *
 * Structural IL risk is high for utility tokens with staking reward inflation.
 * Hard exits (outOfRangeMinutes, maxDurationHours) are the primary protection.
 *
 * Tier: any MC >= 500K, age >= 48h, vol spike confirmed
 * Profile: HIGH risk / HIGH reward / SHORT duration
 */
export const scalpSpikeStrategy: Strategy = {
  id: 'scalp-spike',
  name: 'Scalp Spike',
  description:
    'Short-duration fee farming on volume-spiking tokens — meme or utility. ' +
    'Classification is driven by vol spike ratio, not token type or MC ceiling. ' +
    'Tight range, hard time exit to limit IL exposure on inflationary tokens.',
  enabled: true,

  filters: {
    minMcUsd:            500_000,          // floor only — no ceiling
    maxMcUsd:            Number.MAX_SAFE_INTEGER,
    minVolume24h:        100_000,
    minLiquidityUsd:      30_000,
    maxTopHolderPct:         100,
    minHolderCount:          300,
    maxAgeHours:         999_999,           // no age ceiling
    minRugcheckScore:         50,           // slightly relaxed vs evil-panda for older tokens
    requireSocialSignal:   false,
    minFeeTvl24hPct:          10,           // spike vol naturally elevates this
  },

  position: {
    binStep:               50,
    rangeDownPct:         -20,
    rangeUpPct:            20,
    distributionType:  'spot',
    solBias:              0.6,
  },

  exits: {
    stopLossPct:           -25,
    takeProfitPct:         100,
    outOfRangeMinutes:      30,
    maxDurationHours:        8,             // tighter than before — IL risk on utility tokens
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.0005,
  },
}
