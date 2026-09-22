/**
 * lib/config-invariants.ts
 *
 * Pure predicate for the fee/TVL exit-vs-entry config invariant.
 *
 * The bot's exit threshold (LP_FEE_TVL_EXIT_THRESHOLD) must be BELOW the entry
 * floor (MIN_FEE_TVL_RATIO_24H * 100), otherwise a freshly opened position
 * fails its own exit check immediately (open→close churn and fee burn).
 *
 * Extracted from lib/startup-validation.ts as a pure, testable predicate.
 * Behavior must remain byte-identical to the historical inline check:
 *   mismatch (exit >= entry)  -> checkFeeTvlExitVsEntry(...) === false
 *   ok (exit < entry)         -> checkFeeTvlExitVsEntry(...) === true
 */

/**
 * @param exitThresholdPct   LP_FEE_TVL_EXIT_THRESHOLD (percent, e.g. 0.75)
 * @param minEntryRatioPct   MIN_FEE_TVL_RATIO_24H * 100 (percent, e.g. 0.5)
 * @returns true when exit < entry (valid config), false when exit >= entry (churn risk)
 */
export function checkFeeTvlExitVsEntry(
  exitThresholdPct: number,
  minEntryRatioPct: number,
): boolean {
  return exitThresholdPct < minEntryRatioPct
}