/**
 * Hermetic tests for pool metric derivations (bot/scanner/pool-metrics.ts).
 *
 * NOTE (transitive imports): pool-metrics imports getHeliusRpcEndpoint from
 * lib/solana (the @solana/web3.js SDK chain). Imports are side-effect free;
 * the suite stays hermetic (no network, no env, no RPC).
 */
import { describe, expect, it } from 'vitest'
import {
  computePoolScore,
  getFeeTvlPct,
  getImpliedActiveTvl,
  getRecentVolumeGrowth,
  isFeeAccelerating,
} from '@/bot/scanner/pool-metrics'
import type { MeteoraPool } from '@/bot/scanner/pool-fetcher'

type Poolish = Record<string, any>

function makePool(fields: Poolish): MeteoraPool {
  return {
    address: 'pool',
    name: 'POOL-SOL',
    tvl: 0,
    current_price: 0.001,
    token_x: { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL' },
    token_y: { address: 'mint', symbol: 'MINT' },
    is_blacklisted: false,
    ...fields,
  } as unknown as MeteoraPool
}

describe('getImpliedActiveTvl', () => {
  it('derives volume_1h / (base_fee_pct / 100)', () => {
    const pool = makePool({
      volume: { '1h': 120 },
      pool_config: { base_fee_pct: 0.3 },
    })
    expect(getImpliedActiveTvl(pool)).toBeCloseTo(40000, 5) // 120 / 0.003
  })

  it('returns 0 when volume or fee rate is missing/zero', () => {
    expect(getImpliedActiveTvl(makePool({ volume: { '1h': 120 } }))).toBe(0) // no fee_pct
    expect(getImpliedActiveTvl(makePool({ pool_config: { base_fee_pct: 1 } }))).toBe(0) // no vol
    expect(getImpliedActiveTvl(makePool({ volume: { '1h': 0 }, pool_config: { base_fee_pct: 1 } }))).toBe(0)
  })
})

describe('isFeeAccelerating', () => {
  it('true when fee_1h > fee_2h / 2 and above the MIN_FEE_24H/24 floor', () => {
    const pool = makePool({ fees: { '1h': 1, '2h': 1 } })
    expect(isFeeAccelerating(pool)).toBe(true)
  })

  it('false when recent 1h fees are below the daily-minimum floor (~5/24)', () => {
    const pool = makePool({ fees: { '1h': 0.2, '2h': 100 } })
    expect(isFeeAccelerating(pool)).toBe(false)
  })

  it('false when fees are not accelerating', () => {
    const pool = makePool({ fees: { '1h': 0.3, '2h': 0.9 } }) // 0.3 < 0.45
    expect(isFeeAccelerating(pool)).toBe(false)
  })

  it('true above floor even with a moderate ratio', () => {
    const pool = makePool({ fees: { '1h': 0.3, '2h': 0.4 } }) // 0.3 > 0.2 and 0.3 > 0.2
    expect(isFeeAccelerating(pool)).toBe(true)
  })
})

describe('getFeeTvlPct', () => {
  it('returns the fee/tvl ratio expressed as a percentage', () => {
    const pool = makePool({ fee_tvl_ratio: { '24h': 0.05 } })
    expect(getFeeTvlPct(pool, '24h')).toBeCloseTo(5, 10)
  })
})

describe('computePoolScore — AC7', () => {
  it('AC7: score = 0.5*feeTvl1h + 0.3*feeTvl24h + 0.2*lpCountNorm with lpCountNorm = min(lpCount,20)/20', () => {
    const pool = makePool({
      fee_tvl_ratio: { '1h': 2, '24h': 1 },
    })
    const result = computePoolScore(pool, 10) // lpNorm = 0.5
    expect(result.feeTvlRatio1h).toBe(2)
    expect(result.feeTvlRatio24h).toBe(1)
    expect(result.lpCountNorm).toBe(0.5)
    expect(result.score).toBeCloseTo(2 * 0.5 + 1 * 0.3 + 0.5 * 0.2, 10) // 1.4
  })

  it('caps lpCountNorm at 20 (LP_SCORE_LP_CAP)', () => {
    const pool = makePool({ fee_tvl_ratio: { '1h': 0, '24h': 0 } })
    const result = computePoolScore(pool, 40)
    expect(result.lpCountNorm).toBe(1)
  })

  it('flooring: negative/zero lp count yields 0 norm', () => {
    const pool = makePool({ fee_tvl_ratio: { '1h': 0, '24h': 0 } })
    expect(computePoolScore(pool, 0).lpCountNorm).toBe(0)
    expect(computePoolScore(pool, -3).lpCountNorm).toBe(0)
  })
})

describe('getRecentVolumeGrowth', () => {
  it('returns 5m-annualized-to-1h / 1h volume', () => {
    const pool = makePool({ volume: { '5m': 10, '1h': 120 } }) // 10*12 / 120 = 1
    expect(getRecentVolumeGrowth(pool)).toBeCloseTo(1, 10)
  })

  it('returns 3 when 1h volume is gone but 5m shows flow', () => {
    const pool = makePool({ volume: { '5m': 10, '1h': 0 } })
    expect(getRecentVolumeGrowth(pool)).toBe(3)
  })

  it('returns 0 with no volume at all', () => {
    const pool = makePool({ volume: { '5m': 0, '1h': 0 } })
    expect(getRecentVolumeGrowth(pool)).toBe(0)
  })
})