/**
 * Hermetic tests for the discrete bin-range log math (lib/bin-math.ts),
 * extracted — behavior byte-identical — from bot/executor/open/bin-calc.ts.
 *
 * NOTE on AC8's "fullBinsDown < fullBinsUp" expectation: the mandated
 * byte-identical formula is
 *     fullBinsDown = |round( ln((100+rangeDownPct)/100) / ln(1+binStep/10000) )|
 *     fullBinsUp   =   round( ln((100+rangeUpPct)/100) / ln(1+binStep/10000) )
 * For the AC8 input (-50% / +100%) the multiplicative factors are exactly 0.5
 * and 2.0, so |ln(0.5)| === ln(2) and the SAME bin count (70/70 — verified by
 * computation) results at any binStep. "down < up" is therefore mathematically
 * impossible under the byte-identical mandate; the tests pin the actual
 * values, the log-vs-linear difference, determinism, and degenerate guards.
 */
import { describe, expect, it } from 'vitest'
import { computeBinDeltas } from '@/lib/bin-math'

describe('computeBinDeltas — AC8 (pinned values, byte-identical log math)', () => {
  it('AC8 input: activeBinId 70000, binStep 100, -50%/+100% -> pinned 70/70, 141 total', () => {
    const result = computeBinDeltas({ activeBinId: 70000, binStep: 100, rangeDownPct: -50, rangeUpPct: 100 })
    expect(result).toEqual({
      fullBinsDown: 70,
      fullBinsUp: 70,
      minBinId: 69930,
      maxBinId: 70070,
      totalBins: 141,
    })
  })

  it('is deterministic across runs (pure function, same input -> same output)', () => {
    const input = { activeBinId: 70000, binStep: 100, rangeDownPct: -50, rangeUpPct: 100 } as const
    const first = computeBinDeltas(input)
    for (let i = 0; i < 5; i++) {
      expect(computeBinDeltas(input)).toEqual(first)
    }
  })

  it('asserts the log-vs-linear difference: log math is ~70 bins, not 5000/10000 linear', () => {
    const result = computeBinDeltas({ activeBinId: 70000, binStep: 100, rangeDownPct: -50, rangeUpPct: 100 })
    // Linear estimate would be pct / (binStep/10000) = 50/0.01 = 5000 (down) and 100/0.01 = 10000 (up).
    // The multiplicative log math must stay an order of magnitude below that.
    expect(result.fullBinsDown).toBeLessThan(1000)
    expect(result.fullBinsUp).toBeLessThan(1000)
    expect(result.fullBinsDown).toBeLessThan(5_000)
    expect(result.fullBinsUp).toBeLessThan(10_000)
  })

  it('true multiplicative asymmetry: unequal |factors| give unequal bins (down 70 > up 41 for -50/+50)', () => {
    // |ln(0.5)| = 0.693 vs ln(1.5) = 0.405 -> the DOWN side is bigger in bins.
    const result = computeBinDeltas({ activeBinId: 70000, binStep: 100, rangeDownPct: -50, rangeUpPct: 50 })
    expect(result.fullBinsDown).toBe(70)
    expect(result.fullBinsUp).toBe(41)
    expect(result.totalBins).toBe(70 + 41 + 1)
  })

  it('degenerate guard: zero range produces a single-bin range, no crash', () => {
    const result = computeBinDeltas({ activeBinId: 70000, binStep: 100, rangeDownPct: 0, rangeUpPct: 0 })
    expect(result).toEqual({
      fullBinsDown: 0,
      fullBinsUp: 0,
      minBinId: 70000,
      maxBinId: 70000,
      totalBins: 1,
    })
  })

  it('returns finite numbers (no throw) for other supported bin steps', () => {
    for (const binStep of [1, 10, 25, 200, 400]) {
      const result = computeBinDeltas({ activeBinId: 70000, binStep, rangeDownPct: -50, rangeUpPct: 100 })
      expect(Number.isFinite(result.fullBinsDown)).toBe(true)
      expect(Number.isFinite(result.fullBinsUp)).toBe(true)
      expect(result.totalBins).toBe(result.maxBinId - result.minBinId + 1)
    }
  })
})