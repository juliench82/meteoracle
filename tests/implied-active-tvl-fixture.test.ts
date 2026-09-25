/**
 * Hermetic, fixture-driven tests for the corrected implied-active-TVL metric
 * (audit finding M6 / batch B8). Pins AC-B8.1 and AC-B8.3 against the RECORDED
 * anonymised candidate set, plus the corrected arithmetic and the fallback-to-tvl
 * path on recorded pools (AC-B8.2).
 *
 * Fixture: tests/fixtures/implied-active-tvl-candidate-pools.json — the activity
 * scanner's REAL candidate set over two live captures (C1 pre-fix, C2 post-fix),
 * 398 anonymised pools, EVERY numeric field verbatim (only pool/token names and
 * non-protocol mints were replaced). Provenance:
 * tests/fixtures/implied-active-tvl-candidate-pools-PROVENANCE.txt.
 *
 * Hermetic: no network, no env, no RPC, no filesystem beyond reading the fixture.
 * The recorded pool objects are the same shape the scanner passes around
 * (`applyJsPreFilter`), so `getImpliedActiveTvl` sees exactly the live payload.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getImpliedActiveTvl } from '@/bot/scanner/pool-metrics'
import { MAX_IMPLIED_ACTIVE_TVL, MIN_IMPLIED_ACTIVE_TVL } from '@/lib/strategy-config'
import type { MeteoraPool } from '@/bot/scanner/pool-fetcher'

type Poolish = Record<string, any>

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'implied-active-tvl-candidate-pools.json'),
    'utf8',
  ),
) as { pools: Poolish[] }

/** Recorded candidate set, every numeric field verbatim (398 pools / 2 captures). */
const recorded = fixture.pools
const recordedPools = recorded as unknown as MeteoraPool[]

/** AC-B8.1 tolerance: "matches pool.tvl within 1%". Mirrors IMPLIED_ACTIVE_TVL_TOLERANCE. */
const ONE_PERCENT = 0.01

/** The historical (buggy) ceiling the old unit scale was compared against. */
const OLD_MAX_IMPLIED_ACTIVE_TVL = 750000

/** The OLD buggy proxy (audit M6): volume_1h / (base_fee_pct / 100). */
function oldBuggyProxy(pool: Poolish): number {
  const vol1h = Number(pool.volume?.['1h'] ?? 0)
  const baseFeePct = Number(pool.pool_config?.base_fee_pct ?? 0)
  return baseFeePct > 0 ? vol1h / (baseFeePct / 100) : 0
}

/** The corrected derivation, spelled out, for an independent comparison. */
function derivedFromFees(pool: Poolish): number {
  return (Number(pool.fees?.['1h']) * 100) / Number(pool.fee_tvl_ratio?.['1h'])
}

/**
 * The activity gate's implied-active-TVL criterion EXACTLY as shipped in
 * bot/scanner/pool-fetcher.ts (applyJsPreFilter):
 *   - `implied === 0`                      -> rejected (ghost pool)
 *   - `implied > 0 && implied < MIN_...`   -> rejected
 *   - `implied > MAX_...`                  -> rejected
 * Kept local because applyJsPreFilter is not exported; the criterion is the
 * subject of AC-B8.3, not the whole gate (other gates — fee_24h, SOL side,
 * fee acceleration — are out of this slice's scope).
 */
function rejectedByActivityCriterion(pool: MeteoraPool): boolean {
  const implied = getImpliedActiveTvl(pool)
  if (implied === 0) return true
  if (implied > 0 && implied < MIN_IMPLIED_ACTIVE_TVL) return true
  if (implied > MAX_IMPLIED_ACTIVE_TVL) return true
  return false
}

describe('implied-active-TVL — recorded candidate fixture (AC-B8.1 / AC-B8.3)', () => {
  it('is the recorded anonymised candidate set: >= 20 pools, usable 1h inputs on every pool', () => {
    expect(recorded.length).toBeGreaterThanOrEqual(20)
    expect(recorded.length).toBe(398) // verbatim: C1 198 + C2 200
    // Every recorded pool must carry the inputs the derivation needs, otherwise
    // AC-B8.1 would be satisfied by the fallback and the test would be vacuous.
    for (const pool of recorded) {
      expect(Number(pool.tvl)).toBeGreaterThan(0)
      expect(Number(pool.fees?.['1h'])).toBeGreaterThan(0)
      expect(Number(pool.fee_tvl_ratio?.['1h'])).toBeGreaterThan(0)
    }
  })

  it('AC-B8.1: getImpliedActiveTvl reproduces pool.tvl within 1% for >= 90% of the recorded pools', () => {
    const matched: Poolish[] = []
    for (const pool of recorded) {
      const implied = getImpliedActiveTvl(pool as unknown as MeteoraPool)
      const tvl = Number(pool.tvl)
      if (Math.abs(implied - tvl) <= tvl * ONE_PERCENT) matched.push(pool)
    }

    // The AC threshold.
    expect(matched.length / recorded.length).toBeGreaterThanOrEqual(0.9)
    // The recorded fact: 398/398 within 1% (max abs diff 2.33e-10).
    expect(matched.length).toBe(recorded.length)
  })

  it('AC-B8.1: the match comes from the fee derivation, NOT the fallback (per recorded pool)', () => {
    // If getImpliedActiveTvl silently fell back to the API tvl, "matches tvl"
    // would hold vacuously. Pin the derivation path per pool: the returned value
    // is bit-identical to fees_1h * 100 / fee_tvl_ratio_1h.
    for (const pool of recorded) {
      const implied = getImpliedActiveTvl(pool as unknown as MeteoraPool)
      expect(implied).toBe(derivedFromFees(pool))
    }
  })

  it('AC-B8.1: per capture, >= 90% of pools match tvl within 1%', () => {
    for (const capture of ['C1', 'C2']) {
      const subset = recorded.filter((p) => p.capture === capture)
      expect(subset.length).toBeGreaterThanOrEqual(20)
      const matched = subset.filter((pool) => {
        const implied = getImpliedActiveTvl(pool as unknown as MeteoraPool)
        return Math.abs(implied - Number(pool.tvl)) <= Number(pool.tvl) * ONE_PERCENT
      })
      expect(matched.length / subset.length).toBeGreaterThanOrEqual(0.9)
      expect(matched.length).toBe(subset.length)
    }
  })

  it("AC-B8.1: the audit's ⠁⠏⠑-SOL case yields ~15,541, not 18.9M", () => {
    // Audit §M6 worked example, re-pinned here so this card's AC is self-contained
    // (the sibling unit-test file pins the same value).
    const pool = {
      address: 'audit-m6-sol',
      name: 'AUDIT-M6-SOL',
      tvl: 15541,
      pool_config: { base_fee_pct: 1 },
      volume: { '1h': 189768.72 },
      fees: { '1h': 3495 },
      fee_tvl_ratio: { '1h': 22.49 },
      token_x: { address: 'mint', symbol: 'MINT' },
      token_y: { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL' },
      is_blacklisted: false,
    } as unknown as MeteoraPool

    const implied = getImpliedActiveTvl(pool)
    expect(implied).toBeCloseTo(15540.24, 2) // 3495 * 100 / 22.49
    expect(implied).toBeLessThan(20000) // not 18.9M
    // ...and the OLD proxy is what produced the ~18.9M figure.
    expect(oldBuggyProxy(pool as unknown as Poolish)).toBeCloseTo(18976872, 0)
  })

  it('AC-B8.2: pins the corrected arithmetic on a recorded pool (fees_1h, fee_tvl_ratio_1h -> tvl)', () => {
    // Recorded pool C1_002: fees_1h 258.06384110412256, fee_tvl_ratio_1h 7.922926503530903,
    // tvl 3257.1782786210974.
    const pool = recorded.find((p) => p.address === 'ANON_POOL_C1_002')!
    expect(pool).toBeDefined()
    expect(getImpliedActiveTvl(pool as unknown as MeteoraPool)).toBeCloseTo(
      Number(pool.tvl),
      6,
    )
    expect(derivedFromFees(pool)).toBeCloseTo(Number(pool.tvl), 6)
    // Sanity: it is NOT the old volume/base_fee proxy for this pool.
    expect(oldBuggyProxy(pool)).not.toBeCloseTo(Number(pool.tvl), 6)
  })

  it('AC-B8.2: falls back to the API tvl when the derivation is unavailable or disagrees (recorded pool)', () => {
    const pool = recorded.find((p) => p.capture === 'C1')!
    const tvl = Number(pool.tvl)

    // Missing / zero 1h fee inputs -> fallback to tvl (recorded pool's cached snapshot).
    expect(getImpliedActiveTvl({ ...pool, fees: {} } as unknown as MeteoraPool)).toBe(tvl)
    expect(getImpliedActiveTvl({ ...pool, fee_tvl_ratio: {} } as unknown as MeteoraPool)).toBe(tvl)
    expect(
      getImpliedActiveTvl({ ...pool, fee_tvl_ratio: { '1h': 0 } } as unknown as MeteoraPool),
    ).toBe(tvl)

    // Ratio inconsistent with the real tvl by >1% -> fallback to tvl.
    const bogusRatio = Number(pool.fee_tvl_ratio['1h']) * 3
    const inconsistent = { ...pool, fee_tvl_ratio: { ...pool.fee_tvl_ratio, '1h': bogusRatio } }
    expect(getImpliedActiveTvl(inconsistent as unknown as MeteoraPool)).toBe(tvl)
  })

  it('AC-B8.3: no pool the old bogus proxy rejected as "too active" is rejected by the activity criterion', () => {
    const oldRejected = recorded.filter((p) => oldBuggyProxy(p) > OLD_MAX_IMPLIED_ACTIVE_TVL)
    // Non-vacuous: the old proxy really did reject 83 recorded pools (40 C1 + 43 C2).
    expect(oldRejected.length).toBe(83)
    expect(oldRejected.filter((p) => p.capture === 'C1').length).toBe(40)
    expect(oldRejected.filter((p) => p.capture === 'C2').length).toBe(43)

    for (const pool of oldRejected) {
      const implied = getImpliedActiveTvl(pool as unknown as MeteoraPool)
      expect(implied).toBeGreaterThan(0)
      expect(implied).toBeGreaterThanOrEqual(MIN_IMPLIED_ACTIVE_TVL)
      expect(implied).toBeLessThanOrEqual(MAX_IMPLIED_ACTIVE_TVL)
      expect(rejectedByActivityCriterion(pool as unknown as MeteoraPool)).toBe(false)
    }
  })

  it('AC-B8.3: the shipped window rejects 0 of the 398 recorded candidate pools', () => {
    const rejected = recordedPools.filter(rejectedByActivityCriterion)
    expect(rejected.length).toBe(0)

    // Grounding: the window covers the recorded distribution in true USD
    // (candidate min 505.4404, max 1614887.7180 across both captures).
    const tvls = recorded.map((p) => Number(p.tvl))
    expect(MIN_IMPLIED_ACTIVE_TVL).toBeLessThanOrEqual(Math.min(...tvls))
    expect(MAX_IMPLIED_ACTIVE_TVL).toBeGreaterThanOrEqual(Math.max(...tvls))
  })
})