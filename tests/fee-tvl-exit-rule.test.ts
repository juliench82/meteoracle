/**
 * Hermetic tests for exit rule #1 — the Fee/TVL yield-collapse predicate
 * (lib/fee-tvl-exit-rule.ts), extracted from bot/monitor.ts.
 *
 * AC-B4.3: with the SHIPPED threshold, the rule must be able to both fire and
 * not fire on realistic recorded values — i.e. it is no longer effectively dead
 * (the H1 defect: a value 100× too large never crossed a 0.75 threshold) and it
 * is not trivially always-firing.
 *
 * The values come from the recorded live fixture (real scanner-selected pools),
 * never from hand-written numbers.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { evaluateFeeTvlCollapseRule } from '@/lib/fee-tvl-exit-rule'
import { LP_FEE_TVL_EXIT_THRESHOLD } from '@/lib/strategy-config'
import { getFeeTvlPct } from '@/bot/scanner/pool-metrics'
import type { MeteoraPool } from '@/bot/scanner/pool-fetcher'

type Poolish = Record<string, any>

const fixtureRaw = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fee-tvl-selected-pools.json'),
  'utf8',
)
const recordedPools = (JSON.parse(fixtureRaw) as { pools: Poolish[] }).pools as unknown as MeteoraPool[]

/** 24h Fee/TVL (%) of every recorded scanner-selected pool, ascending. */
const recordedPcts = recordedPools.map((p) => getFeeTvlPct(p, '24h')).sort((a, b) => a - b)
const ANY_SAMPLE_COUNT = 50
const OLD_POSITION_HOURS = 3 // > 1h, so only the 5-sample gate applies

function fireAt(valuePct: number, thresholdPct: number, sampleCount = ANY_SAMPLE_COUNT) {
  return evaluateFeeTvlCollapseRule({
    feeTvl4hAvg: valuePct,
    sampleCount,
    positionAgeHours: OLD_POSITION_HOURS,
    thresholdPct,
  })
}

describe('evaluateFeeTvlCollapseRule — exit rule #1 (AC-B4.3)', () => {
  it('fixture sanity: at least 20 recorded scanner-selected pools', () => {
    expect(recordedPcts.length).toBeGreaterThanOrEqual(20)
  })

  it('AC-B4.3 (negative control): under the H1 defect (value × 100 vs threshold 0.75) NOT ONE recorded pool could fire — the rule was dead', () => {
    expect(recordedPcts.length).toBeGreaterThan(0)
    // Faithful reproduction of the pre-fix comparison: the scanner fed
    // `getFeeTvlRatio() * 100` (i.e. percent × 100) into a 0.75 threshold.
    const fired = recordedPcts.filter((v) => fireAt(v * 100, 0.75).fire)
    expect(fired).toEqual([])
    // …and the smallest recorded value proves why: 0.5449% became 54.49.
    expect(recordedPcts[0] * 100).toBeGreaterThan(0.75)
  })

  it('AC-B4.3: under the SHIPPED threshold the rule fires on a genuinely collapsed recorded value', () => {
    const worst = recordedPcts[0]
    const result = fireAt(worst, LP_FEE_TVL_EXIT_THRESHOLD)
    expect(result.fire).toBe(true)
    expect(result.reason).toBe(`fee_tvl_yield_low_4havg_${worst.toFixed(2)}pct`)
  })

  it('AC-B4.3: under the SHIPPED threshold the rule does NOT fire on a healthy recorded value', () => {
    const best = recordedPcts[recordedPcts.length - 1]
    const result = fireAt(best, LP_FEE_TVL_EXIT_THRESHOLD)
    expect(result.fire).toBe(false)
    expect(result.reason).toBeNull()
  })

  it('AC-B4.3: on the recorded distribution the rule both fires and does not fire (neither dead nor always-firing)', () => {
    const fires = recordedPcts.filter((v) => fireAt(v, LP_FEE_TVL_EXIT_THRESHOLD).fire)
    expect(fires.length).toBeGreaterThan(0)
    expect(fires.length).toBeLessThan(recordedPcts.length)
  })

  it('min-sample gate: a young position needs 10 samples, an older one 5', () => {
    const collapsed = recordedPcts[0]
    expect(
      evaluateFeeTvlCollapseRule({
        feeTvl4hAvg: collapsed,
        sampleCount: 9,
        positionAgeHours: 0.5,
        thresholdPct: LP_FEE_TVL_EXIT_THRESHOLD,
      }).fire,
    ).toBe(false)
    expect(
      evaluateFeeTvlCollapseRule({
        feeTvl4hAvg: collapsed,
        sampleCount: 10,
        positionAgeHours: 0.5,
        thresholdPct: LP_FEE_TVL_EXIT_THRESHOLD,
      }).fire,
    ).toBe(true)
    expect(
      evaluateFeeTvlCollapseRule({
        feeTvl4hAvg: collapsed,
        sampleCount: 5,
        positionAgeHours: 2,
        thresholdPct: LP_FEE_TVL_EXIT_THRESHOLD,
      }).fire,
    ).toBe(true)
  })

  it('never fires without a usable sample', () => {
    for (const avg of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        evaluateFeeTvlCollapseRule({
          feeTvl4hAvg: avg as number | null,
          sampleCount: 999,
          positionAgeHours: 5,
          thresholdPct: LP_FEE_TVL_EXIT_THRESHOLD,
        }).fire,
      ).toBe(false)
    }
  })

  it('the shipped threshold sits inside the recorded distribution (not below its minimum, not above its max)', () => {
    expect(LP_FEE_TVL_EXIT_THRESHOLD).toBeGreaterThan(recordedPcts[0])
    expect(LP_FEE_TVL_EXIT_THRESHOLD).toBeLessThan(recordedPcts[recordedPcts.length - 1])
  })
})