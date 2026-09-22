/**
 * lib/bin-math.ts
 *
 * Pure discrete bin-range math for the evil-panda Bid-Ask strategy.
 *
 * Extracted from bot/executor/open/bin-calc.ts (checkFullEvilPandaRangeFeasibility)
 * so the safety-critical log math can be tested hermetically. The formula below
 * MUST remain byte-identical to the code it was extracted from:
 *   Math.round(Math.log((100 + pct) / 100) / Math.log(1 + binStep / 10000))
 * with the down direction wrapped in Math.abs(Math.round(...)).
 */

export interface BinDeltaInput {
  activeBinId: number
  binStep: number
  /** e.g. -50 for a -50% downward range */
  rangeDownPct: number
  /** e.g. 100 for a +100% upward range */
  rangeUpPct: number
}

export interface BinDeltas {
  fullBinsDown: number
  fullBinsUp: number
  minBinId: number
  maxBinId: number
  totalBins: number
}

/**
 * Computes the discrete bin deltas for the desired price range using the exact
 * Math.round(log) math the bot has always used (matches Meteora's UI log math
 * rather than a linear pct/binStep estimate).
 *
 * Deterministic: same inputs always produce the same outputs.
 */
export function computeBinDeltas({
  activeBinId,
  binStep,
  rangeDownPct,
  rangeUpPct,
}: BinDeltaInput): BinDeltas {
  const s = binStep / 10000

  // Geometric (log) math: price moves are multiplicative, so linear
  // (pct / s) estimates massively over-count bins for large % moves.
  const fullBinsDown = Math.abs(Math.round(Math.log((100 + rangeDownPct) / 100) / Math.log(1 + s)))
  const fullBinsUp = Math.round(Math.log((100 + rangeUpPct) / 100) / Math.log(1 + s))

  const minBinId = activeBinId - fullBinsDown
  const maxBinId = activeBinId + fullBinsUp
  const totalBins = maxBinId - minBinId + 1

  return { fullBinsDown, fullBinsUp, minBinId, maxBinId, totalBins }
}