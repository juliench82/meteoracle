/**
 * strategies/pre-grad.ts
 *
 * Strategy config for the pre-graduation spot-buy pipeline.
 * Imported by spot-buyer.ts and spot-monitor.ts.
 */

export interface PreGradStrategyConfig {
  id: string
  scanner: {
    minBondingProgress: number
    maxBondingProgress: number
    minVolume5minSol: number
    minHolders: number
    maxTopHolderPct: number
  }
  position: {
    spotBuySol: number
    maxConcurrentSpots: number
    maxTotalSpotSol: number
  }
  exits: {
    takeProfitPct: number
    stopLossPct: number          // negative number, e.g. -40
    maxHoldMinutes: number
    migrateToLpOnGraduation: boolean
    lpPctOfBag: number           // % of token bag to put into LP
  }
}

export const PRE_GRAD_STRATEGY: PreGradStrategyConfig = {
  id: 'pre-grad',
  scanner: {
    minBondingProgress:  parseFloat(process.env.PRE_GRAD_MIN_BONDING_PCT  ?? '80'),
    maxBondingProgress:  parseFloat(process.env.PRE_GRAD_MAX_BONDING_PCT  ?? '99'),
    minVolume5minSol:    parseFloat(process.env.PRE_GRAD_MIN_VOL_5MIN_SOL ?? '5'),
    minHolders:          parseInt(process.env.PRE_GRAD_MIN_HOLDERS         ?? '50'),
    maxTopHolderPct:     parseFloat(process.env.PRE_GRAD_MAX_TOP_HOLDER    ?? '20'),
  },
  position: {
    spotBuySol:          parseFloat(process.env.SPOT_BUY_SOL               ?? '0.05'),
    maxConcurrentSpots:  parseInt(process.env.MAX_CONCURRENT_SPOTS          ?? '3'),
    maxTotalSpotSol:     parseFloat(process.env.MAX_TOTAL_SPOT_SOL          ?? '0.15'),
  },
  exits: {
    takeProfitPct:       parseFloat(process.env.PRE_GRAD_TP_PCT             ?? '200'),
    stopLossPct:         parseFloat(process.env.PRE_GRAD_SL_PCT             ?? '-40'),
    maxHoldMinutes:      parseInt(process.env.PRE_GRAD_MAX_HOLD_MIN         ?? '240'),
    migrateToLpOnGraduation: process.env.PRE_GRAD_MIGRATE_LP !== 'false',
    lpPctOfBag:          parseFloat(process.env.PRE_GRAD_LP_PCT_BAG         ?? '50'),
  },
}
