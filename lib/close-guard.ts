/**
 * lib/close-guard.ts
 *
 * Pure helpers for the persisted close-in-progress marker (M4).
 *
 * `closePosition` in bot/executor/close.ts writes a `close_in_progress_at` timestamp
 * into local position state immediately before it sends the removeLiquidity tx, and
 * clears it (null) in the completion/finally path on both success and failure.
 *
 * The in-memory mutex in close.ts cannot survive a PM2 restart, so the persisted
 * marker is the only guard that prevents a second removeLiquidity for the same
 * position after a crash/restart. A marker that is older than the staleness window
 * is ignored, so a close that crashed before clearing it can never wedge a position
 * forever.
 *
 * No I/O, no network, no env at import time — trivially unit-testable.
 */

/** Default staleness window for the close-in-progress marker, in minutes. */
export const DEFAULT_CLOSE_IN_PROGRESS_STALE_MIN = 15

/**
 * Resolve the staleness window (in milliseconds) from `CLOSE_IN_PROGRESS_STALE_MIN`
 * (minutes). Unset, non-numeric, zero or negative values fall back to the default
 * (15 minutes), so a bad env value can never disable the staleness escape hatch.
 */
export function getCloseInProgressStaleMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CLOSE_IN_PROGRESS_STALE_MIN
  const minutes = raw !== undefined && raw.trim() !== '' ? Number(raw) : NaN
  const effective = Number.isFinite(minutes) && minutes > 0
    ? minutes
    : DEFAULT_CLOSE_IN_PROGRESS_STALE_MIN
  return effective * 60_000
}

/** Minimal shape needed to evaluate the marker (a local-state LP position row). */
export interface CloseMarkerPosition {
  close_in_progress_at?: string | null
}

/**
 * True when `position` carries a *fresh* close-in-progress marker:
 * the marker is present, parses as a date, and its age is strictly less than `staleMs`.
 *
 * A missing or unparseable marker is never fresh. A marker timestamped in the future
 * (clock skew) is treated as fresh — it cannot be a crashed stale close.
 */
export function isCloseInProgressFresh(
  position: CloseMarkerPosition | null | undefined,
  nowMs: number,
  staleMs: number,
): boolean {
  const raw = position?.close_in_progress_at
  if (!raw) return false
  const startedMs = new Date(raw).getTime()
  if (!Number.isFinite(startedMs)) return false
  return nowMs - startedMs < staleMs
}