/**
 * strategies/pre-grad-legacy.ts
 *
 * FROZEN 2026-04-17 — do not modify.
 * This is the exact pre-grad spot-buy strategy as it was before the
 * pivot to Meteora DLMM-only pipeline.
 *
 * Kept for reference / backtesting comparison.
 * Not imported by any active pipeline.
 *
 * Original constants (all env-overridable):
 *   minBondingProgress:   88%
 *   maxBondingProgress:   98%
 *   minVolume5minSol:     8 SOL
 *   minHolders:           100
 *   maxTopHolderPct:      12%
 *   maxDevWalletPct:      3%
 *   minVelocitySolPerMin: 0 (disabled)
 *   spotBuySol:           0.05 SOL
 *   maxConcurrentSpots:   3
 *   maxTotalSpotSol:      0.15 SOL
 *   takeProfitPct:        +150%
 *   stopLossPct:          -35%
 *   maxHoldMinutes:       90 min
 */

export interface PreGradStrategyConfig {
  id: string
  scanner: {
    minBondingProgress:   number
    maxBondingProgress:   number
    minVolume5minSol:     number
    minHolders:           number
    maxTopHolderPct:      number
    maxDevWalletPct:      number
    minVelocitySolPerMin: number
  }
  position: {
    spotBuySol:         number
    maxConcurrentSpots: number
    maxTotalSpotSol:    number
  }
  exits: {
    takeProfitPct:           number
    stopLossPct:             number
    maxHoldMinutes:          number
    migrateToLpOnGraduation: boolean
    lpPctOfBag:              number
  }
}

/** @deprecated — frozen, not used in active pipeline */
export const PRE_GRAD_LEGACY_STRATEGY: PreGradStrategyConfig = {
  id: 'pre-grad-legacy',
  scanner: {
    minBondingProgress:   88,
    maxBondingProgress:   98,
    minVolume5minSol:     8,
    minHolders:           100,
    maxTopHolderPct:      12,
    maxDevWalletPct:      3,
    minVelocitySolPerMin: 0,
  },
  position: {
    spotBuySol:         0.05,
    maxConcurrentSpots: 3,
    maxTotalSpotSol:    0.15,
  },
  exits: {
    takeProfitPct:           150,
    stopLossPct:             -35,
    maxHoldMinutes:          90,
    migrateToLpOnGraduation: true,
    lpPctOfBag:              50,
  },
}
