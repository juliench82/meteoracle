import type { Strategy } from '@/lib/types'

/**
 * Stable Farm Strategy
 * Targets established, liquid pairs (SOL/USDC, SOL/USDT, stablecoin pairs)
 * with consistent high volume. Uses Curve distribution and a tight bin step
 * to maximize fee density around the active price. Low risk, low maintenance,
 * long duration.
 *
 * Profile: LOW risk / STEADY yield / LONG duration
 */
export const stableFarmStrategy: Strategy = {
  id: 'stable-farm',
  name: 'Stable Farm',
  description:
    'Curve-distribution fee farming on high-liquidity established pairs. Targets SOL/USDC, SOL/USDT, and major stablecoin pools with deep liquidity. Narrow range, tight bin step, long hold.',
  enabled: true,

  filters: {
    // Large cap or stablecoin pairs only
    minMcUsd: 10_000_000,
    maxMcUsd: Number.MAX_SAFE_INTEGER, // no upper limit for established pairs

    // Must have substantial daily volume
    minVolume24h: 1_000_000,

    // Deep liquidity required — this is the whole premise
    minLiquidityUsd: 500_000,

    // Established projects — holder concentration matters less for SOL/USDC
    maxTopHolderPct: 30,
    minHolderCount: 1000,

    // No age restriction — we want old, proven pairs
    maxAgeHours: 999999,

    // Lower rugcheck threshold — large established tokens score differently
    minRugcheckScore: 40,

    requireSocialSignal: false,

    minFeeTvl24hPct: 4, // steady is enough here — BLUECHIP/STABLE doesn't need to be screaming hot
  },

  position: {
    // Very tight bin step — stables move slowly, capture more volume per bin
    binStep: 5,

    // Tight range: ±10% around current price
    rangeDownPct: -10,
    rangeUpPct: 10,

    // Curve distribution — concentrate liquidity at the center
    distributionType: 'curve',

    // Balanced 50/50 deposit for stable pairs
    solBias: 0.5,

    // Larger position size — lower risk profile allows more capital
    maxSolPerPosition: 2.0,
  },

  exits: {
    // Wide stop loss — established pairs don't crash like memes
    stopLossPct: -15,

    // No rush to take profit — compound fees over time
    takeProfitPct: 500,

    // Tightened from 240 — rebalance after 60min OOR
    outOfRangeMinutes: 60,

    // Long duration — this is a farming strategy, not a trade
    maxDurationHours: 168, // 7 days

    claimFeesBeforeClose: true,
    minFeesToClaim: 0.005, // higher threshold — larger positions earn more
  },
}
