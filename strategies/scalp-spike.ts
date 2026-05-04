import type { Strategy } from '@/lib/types'

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

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
    minMcUsd:            envNumber('SCALP_SPIKE_MIN_MC_USD', 500_000), // floor only — no ceiling
    maxMcUsd:            envNumber('SCALP_SPIKE_MAX_MC_USD', Number.MAX_SAFE_INTEGER),
    minVolume24h:        envNumber('SCALP_SPIKE_MIN_VOLUME_24H', 100_000),
    minLiquidityUsd:     envNumber('SCALP_SPIKE_MIN_LIQUIDITY_USD', 30_000),
    maxTopHolderPct:     envNumber('SCALP_SPIKE_MAX_TOP_HOLDER_PCT', 70),
    minHolderCount:      envNumber('SCALP_SPIKE_MIN_HOLDER_COUNT', 300),
    maxAgeHours:         envNumber('SCALP_SPIKE_MAX_AGE_HOURS', 999_999), // no age ceiling
    minRugcheckScore:    envNumber('SCALP_SPIKE_MIN_RUGCHECK_SCORE', 50), // slightly relaxed vs evil-panda
    requireSocialSignal:   false,
    minFeeTvl24hPct:      envNumber('SCALP_SPIKE_MIN_FEE_TVL_24H_PCT', 0),
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
    outOfRangeMinutes:     envNumber('SCALP_SPIKE_OOR_MINUTES', 10),
    maxDurationHours:        8,             // tighter than before — IL risk on utility tokens
    claimFeesBeforeClose:  true,
    minFeesToClaim:       0.0005,
  },
}
