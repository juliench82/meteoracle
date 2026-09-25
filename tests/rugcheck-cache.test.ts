/**
 * Hermetic tests for bot/rugcheck-cache.ts — the G7 rugcheck circuit breaker.
 *
 * `@/lib/rugcheck` is mocked so `checkRugscore` can be made to THROW (API outage
 * surfaces from lib/rugcheck.ts as its -1 sentinel; here we throw to exercise the
 * catch path). `@/bot/alerter` is mocked so `sendAlert` call counts are observable
 * without Telegram. `@/lib/circuit-breaker` is mocked ONLY as a guard: getRugscore
 * must never reach isDailyLossLimitHit (the daily-loss breaker is a separate concern).
 *
 * Breaker state (consecutiveFailures / breakerOpen / alertedThisOpen) is
 * module-level, so resetModules + a fresh dynamic import per test gives each
 * case a clean slate.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockCheckRugscore, mockSendAlert, mockIsDailyLossLimitHit } = vi.hoisted(() => ({
  mockCheckRugscore: vi.fn(),
  mockSendAlert: vi.fn().mockResolvedValue(undefined),
  mockIsDailyLossLimitHit: vi.fn().mockResolvedValue(false),
}))

vi.mock('@/lib/rugcheck', () => ({ checkRugscore: mockCheckRugscore }))
vi.mock('@/bot/alerter', () => ({ sendAlert: mockSendAlert }))
vi.mock('@/lib/circuit-breaker', () => ({ isDailyLossLimitHit: mockIsDailyLossLimitHit }))

let getRugscore: (addr: string, sym?: string) => Promise<number>

// Fresh module (and thus fresh breaker state) per test, with clean env + reset mocks.
beforeEach(async () => {
  delete process.env.RUGCHECK_OUTAGE_SCORE
  delete process.env.RUGCHECK_CIRCUIT_FAILURE_THRESHOLD
  vi.resetModules()
  mockCheckRugscore.mockReset()
  mockSendAlert.mockClear() // keep mockResolvedValue(undefined) impl
  mockIsDailyLossLimitHit.mockClear()
  const mod = await import('@/bot/rugcheck-cache')
  getRugscore = mod.getRugscore
})

describe('rugcheck circuit breaker (G7 — fail-open on sustained outage)', () => {
  it('below threshold: hard reject (0), no alert', async () => {
    mockCheckRugscore.mockRejectedValue(new Error('outage'))
    expect(await getRugscore('tok-aaa')).toBe(0)
    expect(await getRugscore('tok-aaa')).toBe(0) // 2 consecutive, still < threshold(3)
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('reaches threshold: opens circuit, returns OUTAGE_SCORE, alerts exactly once', async () => {
    mockCheckRugscore.mockRejectedValue(new Error('outage'))
    await getRugscore('tok-bbb') // 1
    await getRugscore('tok-bbb') // 2
    const r = await getRugscore('tok-bbb') // 3 -> threshold reached, breaker OPEN
    expect(r).toBe(100) // default OUTAGE_SCORE (RUGCHECK_OUTAGE_SCORE unset)
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(mockSendAlert).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('circuit breaker OPEN') }),
    )
  })

  it('while open: no further alerts for continued failures', async () => {
    mockCheckRugscore.mockRejectedValue(new Error('outage'))
    for (let i = 0; i < 3; i++) await getRugscore('tok-ccc') // opens + 1 alert
    await getRugscore('tok-ccc')
    await getRugscore('tok-ccc')
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(await getRugscore('tok-ccc')).toBe(100)
  })

  it('recovers on first success: resets breaker, returns real score, re-alerts on next outage', async () => {
    mockCheckRugscore.mockRejectedValue(new Error('outage'))
    for (let i = 0; i < 3; i++) await getRugscore('tok-dd') // open + alert
    mockCheckRugscore.mockResolvedValue(73)
    expect(await getRugscore('tok-dd')).toBe(73) // reset; real score returned
    expect(mockSendAlert).toHaveBeenCalledTimes(1) // no SECOND alert on the success

    // A fresh outage after recovery must alert again (alertedThisOpen was reset).
    mockCheckRugscore.mockRejectedValue(new Error('outage'))
    for (let i = 0; i < 3; i++) await getRugscore('tok-dd')
    expect(mockSendAlert).toHaveBeenCalledTimes(2)
  })

  it('does not invoke isDailyLossLimitHit (daily-loss breaker stays separate)', async () => {
    mockCheckRugscore.mockRejectedValue(new Error('outage'))
    for (let i = 0; i < 6; i++) await getRugscore('tok-ee') // exceeds threshold, opens
    expect(mockIsDailyLossLimitHit).not.toHaveBeenCalled()
  })
})
