import type { Strategy } from '@/lib/types'

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const scalpSpikeStrategy: Strategy = {
  id: 'scalp-spike',
  version: 'v1.1',
  name: 'Scalp Spike',
  description: 'SOL-paired tokens with a live 5m/1h volume spike. Tight range, hard exit.',
  enabled: true,
  filters: {
    minMcUsd: envNumber('SCALP_SPIKE_MIN_MC_USD', 500_000),
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 0,
    minLiquidityUsd: envNumber('SCALP_SPIKE_MIN_LIQUIDITY_USD', 10_000),
    maxTopHolderPct: envNumber('SCALP_SPIKE_MAX_TOP_HOLDER_PCT', 25),
    minHolderCount: envNumber('SCALP_SPIKE_MIN_HOLDER_COUNT', 200),
    maxAgeHours: Number.MAX_SAFE_INTEGER,
    minRugcheckScore: envNumber('SCALP_SPIKE_MIN_RUGCHECK_SCORE', 400),
    requireSocialSignal: false,
    minFeeTvl24hPct: 0,
  },
  position: {
    binStep: envNumber('SCALP_SPIKE_BIN_STEP', 100),
    rangeDownPct: envNumber('SCALP_SPIKE_RANGE_DOWN_PCT', -20),
    rangeUpPct: envNumber('SCALP_SPIKE_RANGE_UP_PCT', 40),
    distributionType: 'spot',
    solBias: envNumber('SCALP_SPIKE_SOL_BIAS', 1),
  },
  exits: {
    stopLossPct: envNumber('SCALP_SPIKE_STOP_LOSS_PCT', -15),
    takeProfitPct: envNumber('SCALP_SPIKE_TAKE_PROFIT_PCT', 30),
    outOfRangeMinutes: envNumber('SCALP_SPIKE_OOR_MINUTES', 15),
    maxDurationHours: envNumber('SCALP_SPIKE_MAX_DURATION_HOURS', 6),
    claimFeesBeforeClose: true,
    minFeesToClaim: envNumber('SCALP_SPIKE_MIN_FEES_TO_CLAIM', 0.001),
    // IL exit: -10% IL on a tight range means the spike already ran hard against us.
    maxIlPct: envNumber('SCALP_SPIKE_MAX_IL_PCT', -10),
  },
}
