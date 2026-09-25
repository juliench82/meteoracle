import type { Strategy } from '@/lib/types'

import {
  envNumber,
  EVIL_PANDA_MAX_AGE_HOURS,
  EVIL_PANDA_MIN_RUGCHECK_SCORE,
  EVIL_PANDA_MIN_HOLDER_COUNT,
  EVIL_PANDA_MIN_LIQUIDITY_USD,
} from '@/lib/strategy-config'

// (Old scoring weights fully removed — no scoring in entry path)

export const evilPandaStrategy: Strategy = {
  id: 'evil-panda',
  version: 'v1.3',
  name: 'Evil Panda',
  description: 'Top-performer SOL-paired DLMM (per revised spec). Server: tvl>=500 && fee_24h>=5 && fee_tvl_ratio_24h>=0.005, sort_by=fee_tvl_ratio_1h:desc (bounded). Client derives on small result: impliedActiveTVL=fees_1h/fee_tvl_ratio_1h*100 (the pool\'s real tvl, 505-339002 USD), fee_1h>(fee_2h/2), age>2h. LP count (positions) only on ~top-5 survivors. Plus deep gates (price dev, Jupiter, rug/holders) + SOL-paired only. Bid-Ask, 1h hard max.',
  enabled: true,
  filters: {
    minMcUsd: 0,
    maxMcUsd: Number.MAX_SAFE_INTEGER,
    minVolume24h: 0,
    minLiquidityUsd: EVIL_PANDA_MIN_LIQUIDITY_USD,
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
    distributionType: 'bid-ask',
    // solBias is kept for future / other uses. Current simple swap model does a fixed split
    // (no longer bin-proportional in the pre-swap). See open.ts for the current simple fixed swap.
    solBias: envNumber('EVIL_PANDA_SOL_BIAS', 1),
  },
  exits: {
    // Snapshot fields required by the ExitRules type.
    // Real LP exits use the LP_* constants in strategy-config.ts.
    stopLossPct: 0,
    takeProfitPct: 0,
    outOfRangeMinutes: envNumber('EVIL_PANDA_OOR_MINUTES', 30),
    maxDurationHours: envNumber('EVIL_PANDA_MAX_DURATION_HOURS', 1),
    claimFeesBeforeClose: true,
    minFeesToClaim: envNumber('EVIL_PANDA_MIN_FEES_TO_CLAIM', 0.001),
  },
}
