/**
 * strategies/pre-grad.ts
 *
 * Strategy config for the pre-graduation spot-buy pipeline.
 * Imported by spot-buyer.ts and spot-monitor.ts.
 *
 * Tuned to converged open-source sniper consensus:
 *   - Curve 88-98% only (skip slow 80% ones — 4x lower grad rate)
 *   - Vol ≥ 8 SOL/5min (was 5)
 *   - Holders ≥ 100 (was 50)
 *   - Top holder ≤ 12% (was 20%)
 *   - Dev wallet ≤ 3% (new — checked via pump.fun API)
 *   - TP 150% (was 200% — real winners peak at 120-180%)
 *   - SL -35% (was -40%)
 *   - Max hold 90 min (was 240 min — never sleep through a -70% bag)
 */

export interface PreGradStrategyConfig {
  id: string
  scanner: {
    minBondingProgress:  number
    maxBondingProgress:  number
    minVolume5minSol:    number
    minHolders:          number
    maxTopHolderPct:     number
    maxDevWalletPct:     number   // NEW — dev concentration check
    minVelocitySolPerMin: number  // NEW — curve progress rate
  }
  position: {
    spotBuySol:          number
    maxConcurrentSpots:  number
    maxTotalSpotSol:     number
  }
  exits: {
    takeProfitPct:            number
    stopLossPct:              number   // negative, e.g. -35
    maxHoldMinutes:           number
    migrateToLpOnGraduation:  boolean
    lpPctOfBag:               number
  }
}

export const PRE_GRAD_STRATEGY: PreGradStrategyConfig = {
  id: 'pre-grad',
  scanner: {
    minBondingProgress:   parseFloat(process.env.PRE_GRAD_MIN_BONDING_PCT    ?? '88'),  // was 80
    maxBondingProgress:   parseFloat(process.env.PRE_GRAD_MAX_BONDING_PCT    ?? '98'),  // was 99
    minVolume5minSol:     parseFloat(process.env.PRE_GRAD_MIN_VOL_5MIN_SOL   ?? '8'),   // was 5
    minHolders:           parseInt(process.env.PRE_GRAD_MIN_HOLDERS           ?? '100'), // was 50
    maxTopHolderPct:      parseFloat(process.env.PRE_GRAD_MAX_TOP_HOLDER      ?? '12'),  // was 20
    maxDevWalletPct:      parseFloat(process.env.PRE_GRAD_MAX_DEV_WALLET_PCT  ?? '3'),   // NEW
    minVelocitySolPerMin: parseFloat(process.env.PRE_GRAD_MIN_VELOCITY        ?? '0'),   // 0 = disabled until data accumulates
  },
  position: {
    spotBuySol:           parseFloat(process.env.SPOT_BUY_SOL                ?? '0.05'),
    maxConcurrentSpots:   parseInt(process.env.MAX_CONCURRENT_SPOTS           ?? '3'),
    maxTotalSpotSol:      parseFloat(process.env.MAX_TOTAL_SPOT_SOL           ?? '0.15'),
  },
  exits: {
    takeProfitPct:            parseFloat(process.env.PRE_GRAD_TP_PCT          ?? '150'),  // was 200
    stopLossPct:              parseFloat(process.env.PRE_GRAD_SL_PCT          ?? '-35'),  // was -40
    maxHoldMinutes:           parseInt(process.env.PRE_GRAD_MAX_HOLD_MIN      ?? '90'),   // was 240
    migrateToLpOnGraduation:  process.env.PRE_GRAD_MIGRATE_LP !== 'false',
    lpPctOfBag:               parseFloat(process.env.PRE_GRAD_LP_PCT_BAG      ?? '50'),
  },
}
