import type { Strategy } from '@/lib/types'

/**
 * Scalp Spike Strategy
 * Targets tokens experiencing sudden volume spikes — new launches, CT pumps, or
 * trending tokens gaining momentum. Deploys a tight range centered on current price
 * to maximize fee capture during the pump window, then exits fast before reversal.
 *
 * Profile: HIGH risk / HIGH reward / SHORT duration
 */
export const scalpSpikeStrategy: Strategy = {
  id: 'scalp-spike',
  name: 'Scalp Spike',
  description:
    'Tight-range fee farming on volume-spiking tokens. Targets tokens with rapid volume growth (5x+ in 1h). Deploys a ±20% range centered on current price, claims fees aggressively, and exits within hours.',
  enabled: true,

  filters: {
    // Smaller MC — early-stage tokens with room to move
    minMcUsd: 50_000,
    maxMcUsd: 5_000_000,

    // Very high volume relative to MC — the spike signal
    minVolume24h: 500_000,

    // Enough liquidity to open a position without major slippage
    minLiquidityUsd: 30_000,

    // Stricter holder checks — smaller cap = higher rug risk
    maxTopHolderPct: 10,
    minHolderCount: 300,

    // Very fresh tokens only — spike window is narrow
    maxAgeHours: 24,

    // Higher rugcheck bar to compensate for smaller MC
    minRugcheckScore: 65,

    requireSocialSignal: false,
  },

  position: {
    // Tight bin step — we want lots of volume to pass through our bins
    binStep: 50,

    // Tight symmetric range: ±20% from entry
    rangeDownPct: -20,
    rangeUpPct: 20,

    // Spot distribution — even liquidity across the tight range
    distributionType: 'spot',

    // More balanced deposit — we want both sides active in a tight range
    solBias: 0.6,

    maxSolPerPosition: 0.3, // smaller position size — higher risk profile
  },

  exits: {
    // Tight stop loss — if it dumps through our range fast, exit
    stopLossPct: -30,

    // Lower take profit target — in/out quickly
    takeProfitPct: 100,

    // Exit quickly if OOR — spike is over
    outOfRangeMinutes: 30,

    // Hard 12h limit — don't hold a spike play overnight
    maxDurationHours: 12,

    claimFeesBeforeClose: true,
    minFeesToClaim: 0.0005, // lower threshold — every bit counts on short plays
  },
}
