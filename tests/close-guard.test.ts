/**
 * Hermetic tests for the M4 close-in-progress marker helpers (lib/close-guard.ts).
 *
 * Pure functions only: no I/O, no network, no env mutation.
 */
import { describe, expect, it } from 'vitest'
import {
  isCloseInProgressFresh,
  getCloseInProgressStaleMs,
  DEFAULT_CLOSE_IN_PROGRESS_STALE_MIN,
} from '@/lib/close-guard'

const STALE_MS = 15 * 60_000
const NOW = Date.parse('2026-01-01T12:00:00.000Z')
const minutesAgo = (mins: number) => new Date(NOW - mins * 60_000).toISOString()

describe('isCloseInProgressFresh — AC-B1.2', () => {
  it('is fresh (true) for a marker 5 minutes old', () => {
    expect(isCloseInProgressFresh({ close_in_progress_at: minutesAgo(5) }, NOW, STALE_MS)).toBe(true)
  })

  it('is stale (false) for a marker 20 minutes old', () => {
    expect(isCloseInProgressFresh({ close_in_progress_at: minutesAgo(20) }, NOW, STALE_MS)).toBe(false)
  })

  it('is not fresh (false) when the marker is unset', () => {
    expect(isCloseInProgressFresh({}, NOW, STALE_MS)).toBe(false)
    expect(isCloseInProgressFresh({ close_in_progress_at: null }, NOW, STALE_MS)).toBe(false)
    expect(isCloseInProgressFresh({ close_in_progress_at: '' }, NOW, STALE_MS)).toBe(false)
    expect(isCloseInProgressFresh(null, NOW, STALE_MS)).toBe(false)
    expect(isCloseInProgressFresh(undefined, NOW, STALE_MS)).toBe(false)
  })

  it('is not fresh for an unparseable marker (never wedges on garbage)', () => {
    expect(isCloseInProgressFresh({ close_in_progress_at: 'not-a-date' }, NOW, STALE_MS)).toBe(false)
  })

  it('boundary: exactly the staleness window is stale; one ms inside is fresh', () => {
    expect(isCloseInProgressFresh({ close_in_progress_at: new Date(NOW - STALE_MS).toISOString() }, NOW, STALE_MS)).toBe(false)
    expect(isCloseInProgressFresh({ close_in_progress_at: new Date(NOW - STALE_MS + 1).toISOString() }, NOW, STALE_MS)).toBe(true)
  })

  it('a future marker (clock skew) counts as fresh, not stale', () => {
    expect(isCloseInProgressFresh({ close_in_progress_at: minutesAgo(-5) }, NOW, STALE_MS)).toBe(true)
  })
})

describe('getCloseInProgressStaleMs', () => {
  it('defaults to 15 minutes when the env var is unset', () => {
    expect(getCloseInProgressStaleMs({})).toBe(DEFAULT_CLOSE_IN_PROGRESS_STALE_MIN * 60_000)
    expect(DEFAULT_CLOSE_IN_PROGRESS_STALE_MIN).toBe(15)
  })

  it('honours a configured value, expressed in minutes', () => {
    expect(getCloseInProgressStaleMs({ CLOSE_IN_PROGRESS_STALE_MIN: '30' })).toBe(30 * 60_000)
    expect(getCloseInProgressStaleMs({ CLOSE_IN_PROGRESS_STALE_MIN: '0.5' })).toBe(30_000)
  })

  it('falls back to the default for empty/invalid/non-positive values', () => {
    for (const bad of ['', '   ', 'abc', '0', '-5', 'NaN']) {
      expect(getCloseInProgressStaleMs({ CLOSE_IN_PROGRESS_STALE_MIN: bad })).toBe(
        DEFAULT_CLOSE_IN_PROGRESS_STALE_MIN * 60_000,
      )
    }
  })
})