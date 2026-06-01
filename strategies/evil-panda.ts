import type { Strategy } from '@/lib/types'

import {
  envNumber,
  EVIL_PANDA_MAX_AGE_HOURS,
  EVIL_PANDA_MIN_RUGCHECK_SCORE,
  EVIL_PANDA_MIN_HOLDER_COUNT,
} from '@/lib/strategy-config'

// (Old scoring weights fully removed — no scoring in entry path)

export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  version: 'v1.1',
  name: 'Evil Panda',
  description: 'New SOL-paired meme tokens. Wide range (-50% / +100%), short duration, fast exit. Positions are capped at 150 bins max for stability.',
  enabled: true,
  filters: {
    minMcUsd: 0,
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 0,
    minLiquidityUsd: envNumber('EVIL_PANDA_MIN_LIQUIDITY_USD', 5_000),
    maxTopHolderPct: envNumber('EVIL_PANDA_MAX_TOP_HOLDER_PCT', 30),
    minHolderCount: EVIL_PANDA_MIN_HOLDER_COUNT,
    maxAgeHours: EVIL_PANDA_MAX_AGE_HOURS,
    minRugcheckScore: EVIL_PANDA_MIN_RUGCHECK_SCORE,
    // Note: requireSocialSignal, minFeeTvl24hPct, and minBinStep are defined in the Strategy type
    // but are not active filters in the current ultra-simplified Evil Panda path.
    // Bin range safety is handled at open time in executor/open.ts instead.
  },
  position: {
    binStep: envNumber('EVIL_PANDA_BIN_STEP', 100),
    rangeDownPct: envNumber('EVIL_PANDA_RANGE_DOWN_PCT', -50),
    rangeUpPct: envNumber('EVIL_PANDA_RANGE_UP_PCT', 100),
    distributionType: 'spot',
    solBias: envNumber('EVIL_PANDA_SOL_BIAS', 1),
  },
  exits: {
    // Only OOR and duration are still snapshotted for fallback compatibility
    // with getPositionExitRules in monitor. All other LP exit logic lives in
    // the LP_* constants in strategy-config.ts.
    outOfRangeMinutes: envNumber('EVIL_PANDA_OOR_MINUTES', 30),
    maxDurationHours: envNumber('EVIL_PANDA_MAX_DURATION_HOURS', 12),
    claimFeesBeforeClose: true,
    minFeesToClaim: envNumber('EVIL_PANDA_MIN_FEES_TO_CLAIM', 0.001),
  },
}
