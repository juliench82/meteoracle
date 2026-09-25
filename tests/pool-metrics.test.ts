/**
 * Hermetic tests for pool metric derivations (bot/scanner/pool-metrics.ts).
 *
 * NOTE (transitive imports): pool-metrics imports getHeliusRpcEndpoint from
 * lib/solana (the @solana/web3.js SDK chain). Imports are side-effect free;
 * the suite stays hermetic (no network, no env, no RPC).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  computePoolScore,
  getFeeTvlPct,
  getFeeTvlRatio,
  getImpliedActiveTvl,
  getRecentVolumeGrowth,
  isFeeAccelerating,
} from '@/bot/scanner/pool-metrics'
import type { MeteoraPool } from '@/bot/scanner/pool-fetcher'
import { LP_FEE_TVL_EXIT_THRESHOLD } from '@/lib/strategy-config'

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

// ── Recorded live fixture (audit H1) ─────────────────────────────────────────
// Anonymised slice of the pools the activity scanner ACTUALLY selected on
// 2026-09-25 (real code path: fetchMeteoraPools -> applyJsPreFilter). Every
// numeric field is verbatim from the API response; only pool names / addresses
// / tradable mints were replaced. See the fixture's `provenance` block.
// H1's root cause was an INVENTED fixture (0.05 -> expects 5); never hand-write
// a value for fee_tvl_ratio — record it.
const fixtureRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fee-tvl-selected-pools.json'),
  'utf8',
)
const recorded = JSON.parse(fixtureRaw) as { pools: Poolish[] }
const recordedPools = recorded.pools as unknown as MeteoraPool[]

/** Linear-interpolation percentile (same definition as in the README derivation). */
function percentile(sortedAsc: number[], q: number): number {
  const k = (sortedAsc.length - 1) * q
  const lo = Math.floor(k)
  const hi = Math.ceil(k)
  if (lo === hi) return sortedAsc[lo]
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (k - lo)
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

describe('getFeeTvlPct — recorded live payloads (AC-B4.1 / AC-B4.2 / AC-B4.4)', () => {
  it('AC-B4.1: returns the API fee_tvl_ratio["24h"] verbatim, for every recorded scanner-selected pool', () => {
    expect(recordedPools.length).toBeGreaterThanOrEqual(20)
    for (const pool of recordedPools) {
      const apiPct = Number(pool.fee_tvl_ratio!['24h'])
      expect(apiPct).toBeGreaterThan(0)
      expect(getFeeTvlPct(pool, '24h')).toBe(apiPct)
    }
  })

  it('AC-B4.1: the recorded API field IS fees_24h / tvl * 100 (a percent), and is NOT fees_24h / tvl', () => {
    for (const pool of recordedPools) {
      const fees24 = Number(pool.fees!['24h'])
      const tvl = Number(pool.tvl)
      const pct = getFeeTvlPct(pool, '24h')
      expect(pct).toBeCloseTo((fees24 / tvl) * 100, 6)
      // If the API returned a raw ratio, dividing by tvl would reproduce it. It does not.
      expect(Math.abs(pct - fees24 / tvl)).toBeGreaterThan(0.1)
    }
  })

  it('AC-B4.1/AC-B4.2: is NOT getFeeTvlRatio * 100 — the ×100 contract is gone', () => {
    for (const pool of recordedPools) {
      const rawRatio = getFeeTvlRatio(pool, '24h')
      expect(getFeeTvlPct(pool, '24h')).toBe(rawRatio)
      expect(getFeeTvlPct(pool, '24h')).not.toBeCloseTo(rawRatio * 100, 6)
    }
  })

  it('AC-B4.1: other windows too (1h) — pure passthrough', () => {
    for (const pool of recordedPools) {
      const apiPct = Number(pool.fee_tvl_ratio!['1h'])
      expect(apiPct).toBeGreaterThan(0)
      expect(getFeeTvlPct(pool, '1h')).toBe(apiPct)
    }
  })

  it('AC-B4.4: the shipped LP_FEE_TVL_EXIT_THRESHOLD is the p10 of this recorded distribution', () => {
    const values = recordedPools.map((p) => getFeeTvlPct(p, '24h')).sort((a, b) => a - b)
    const p10 = percentile(values, 0.1)
    // Documented in README + lib/strategy-config.ts: p10 = 5.5389 -> default 5.54
    expect(p10).toBeCloseTo(5.5389, 3)
    expect(LP_FEE_TVL_EXIT_THRESHOLD).toBeCloseTo(Math.round(p10 * 100) / 100, 10)
    expect(values.length).toBeGreaterThanOrEqual(20)
  })

  it('AC-B4.2: no test asserts the old invented 0.05 -> 5 fixture', () => {
    // The recorded payload never contains 0.05 for fee_tvl_ratio['24h']; guard against
    // re-introducing the invented value that locked the bug.
    for (const pool of recordedPools) {
      expect(Number(pool.fee_tvl_ratio!['24h'])).not.toBe(0.05)
    }
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