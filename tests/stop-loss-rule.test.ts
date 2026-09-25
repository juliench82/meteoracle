/**
 * Hermetic tests for lib/stop-loss-rule.ts — the pure Net-PnL SL predicate (G6).
 *
 * Covers the interim (-15%) SL that is active during the Fee/TVL warm-up
 * window (ageMin < graceMin) and the regular (-30%) SL that takes over after.
 */
import { describe, expect, it } from 'vitest'
import { evaluateNetPnLStopLoss } from '@/lib/stop-loss-rule'

const grace = 20
const interim = -15
const regular = -30

const base = (over: Partial<Parameters<typeof evaluateNetPnLStopLoss>[0]>) =>
  evaluateNetPnLStopLoss({
    ageMin: 5,
    netPnl: -16,
    graceMin: grace,
    interimPct: interim,
    regularPct: regular,
    ...over,
  })

describe('evaluateNetPnLStopLoss (G6 interim + regular net-PnL SL)', () => {
  it('fires interim SL during warm-up (ageMin < grace, netPnl <= interim)', () => {
    const r = base({ ageMin: 5, netPnl: -16 })
    expect(r.fire).toBe(true)
    expect(r.rule).toBe('interim')
    expect(r.reason).toBe('net_pnl_interim_sl_-16.0pct')
  })

  it('does NOT fire inside warm-up when loss sits between interim and regular', () => {
    const r = base({ ageMin: 5, netPnl: -14 })
    expect(r.fire).toBe(false)
    expect(r.reason).toBeNull()
    expect(r.rule).toBeNull()
  })

  it('prevents >50% loss in the first 20 min (interim fires at -50%)', () => {
    const r = base({ ageMin: 5, netPnl: -50 })
    expect(r.fire).toBe(true)
    expect(r.rule).toBe('interim')
  })

  it('defers after warm-up when loss is between interim and regular (ageMin>=20, -20%)', () => {
    const r = base({ ageMin: 25, netPnl: -20 })
    expect(r.fire).toBe(false)
    expect(r.reason).toBeNull()
    expect(r.rule).toBeNull()
  })

  it('fires regular SL after grace (ageMin>=20, netPnl <= regular)', () => {
    const r = base({ ageMin: 25, netPnl: -35 })
    expect(r.fire).toBe(true)
    expect(r.rule).toBe('regular')
    expect(r.reason).toBe('net_pnl_sl_-35.0pct')
  })

  it('never fires on a null (unavailable) net PnL', () => {
    const r = base({ netPnl: null })
    expect(r.fire).toBe(false)
    expect(r.reason).toBeNull()
    expect(r.rule).toBeNull()
  })
})
