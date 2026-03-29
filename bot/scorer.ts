/**
 * Scorer — ranks candidates by composite score
 * TODO: implement in feat/strategies branch
 */
export function scoreCandidate(_token: Record<string, unknown>): number {
  // Composite score:
  // - volume momentum (volume/MC ratio)
  // - holder growth velocity
  // - rugcheck score
  // - time since launch (fresh = higher priority)
  console.log('[scorer] stub — implement in feat/strategies')
  return 0
}
