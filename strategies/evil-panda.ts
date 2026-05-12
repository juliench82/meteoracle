import type { Strategy } from '@/lib/types'

function envNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  version: 'v1.1',
  name: 'Evil Panda',
  description: 'New SOL-paired meme tokens. Wide range, short duration, fast exit.',
  enabled: true,
  filters: {
    minMcUsd: 0,
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 0,
    minLiquidityUsd: envNumber('EVIL_PANDA_MIN_LIQUIDITY_USD', 5_000),
    maxTopHolderPct: envNumber('EVIL_PANDA_MAX_TOP_HOLDER_PCT', 30),
    minHolderCount: envNumber('EVIL_PANDA_MIN_HOLDER_COUNT', 100),
    maxAgeHours: envNumber('EVIL_PANDA_MAX_AGE_HOURS', 2),
    minRugcheckScore: envNumber('EVIL_PANDA_MIN_RUGCHECK_SCORE', 300),
    requireSocialSignal: false,
    minFeeTvl24hPct: 0,
    minBinStep: envNumber('EVIL_PANDA_MIN_BIN_STEP', 80),
  },
  position: {
    binStep: envNumber('EVIL_PANDA_BIN_STEP', 100),
    rangeDownPct: envNumber('EVIL_PANDA_RANGE_DOWN_PCT', -50),
    rangeUpPct: envNumber('EVIL_PANDA_RANGE_UP_PCT', 100),
    distributionType: 'spot',
    solBias: envNumber('EVIL_PANDA_SOL_BIAS', 1),
  },
  exits: {
    stopLossPct: envNumber('EVIL_PANDA_STOP_LOSS_PCT', -25),
    takeProfitPct: envNumber('EVIL_PANDA_TAKE_PROFIT_PCT', 50),
    outOfRangeMinutes: envNumber('EVIL_PANDA_OOR_MINUTES', 30),
    maxDurationHours: envNumber('EVIL_PANDA_MAX_DURATION_HOURS', 12),
    claimFeesBeforeClose: true,
    minFeesToClaim: envNumber('EVIL_PANDA_MIN_FEES_TO_CLAIM', 0.001),
    // IL exit: -15% IL ≈ 2.3× price move from entry. Override via env.
    maxIlPct: envNumber('EVIL_PANDA_MAX_IL_PCT', -15),
  },
}
