/**
 * Hermetic tests for the fee/TVL exit-vs-entry config invariant
 * (lib/config-invariants.ts), its consumption on the OPEN path
 * (lib/config-invariant-gate.ts), and the guarantee that EXITS are untouched
 * — AC-B5.1, AC-B5.2, AC-B5.3, AC-B5.4, AC-B5.5.
 *
 * Synthetic/numeric config values only — no personal or financial data.
 * The Telegram alerter is mocked: no network, no Telegram credentials.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/bot/alerter', () => ({ sendAlert: vi.fn(async () => {}) }))

import { sendAlert } from '@/bot/alerter'
import { checkFeeTvlExitVsEntry } from '@/lib/config-invariants'
import { validateStartup } from '@/lib/startup-validation'
import {
  CONFIG_INVARIANT_BLOCK_REASON,
  enforceConfigInvariantOpenGate,
  resetConfigInvariantAlertForTests,
} from '@/lib/config-invariant-gate'
import { LP_FEE_TVL_EXIT_THRESHOLD, MIN_FEE_TVL_RATIO_24H } from '@/lib/strategy-config'
import { evaluateFeeTvlCollapseRule } from '@/lib/fee-tvl-exit-rule'

// Deliberately broken pair (the exact H3 mismatch): exit (5.54) >= entry (0.5).
const BROKEN_EXIT = 5.54
const BROKEN_ENTRY = 0.5

/**
 * Models the scanner's OPEN gate exactly as bot/scanner/deep-checker.ts does
 * (lines ~351-358): consult the invariant; when it refuses, no open is
 * attempted and the tick reports openBlockedReason = the invariant reason.
 */
async function attemptOpen(env: NodeJS.ProcessEnv) {
  const { gate, alertEmitted } = await enforceConfigInvariantOpenGate(BROKEN_EXIT, BROKEN_ENTRY, env)
  if (!gate.openAllowed) {
    return { opened: false as const, openBlockedReason: gate.reason, alertEmitted }
  }
  return { opened: true as const, openBlockedReason: undefined, alertEmitted }
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  // The alert is once-per-process latched: without this the latch leaks across tests.
  resetConfigInvariantAlertForTests()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('checkFeeTvlExitVsEntry — AC9 (predicate contract, unchanged)', () => {
  it('AC9: (0.75, 0.5) => false — exit above entry is a mismatch', () => {
    expect(checkFeeTvlExitVsEntry(0.75, 0.5)).toBe(false)
  })

  it('AC9: (0.75, 0.75) => false — strict equality is still a mismatch', () => {
    expect(checkFeeTvlExitVsEntry(0.75, 0.75)).toBe(false)
  })

  it('AC9: (0.3, 0.5) => true — exit below entry is valid', () => {
    expect(checkFeeTvlExitVsEntry(0.3, 0.5)).toBe(true)
  })

  it('boundary sanity: exit just below entry is valid', () => {
    expect(checkFeeTvlExitVsEntry(0.4999, 0.5)).toBe(true)
  })
})

describe('AC-B5.1 — the SHIPPED DEFAULT pair satisfies its own invariant', () => {
  it('checkFeeTvlExitVsEntry(LP_FEE_TVL_EXIT_THRESHOLD, MIN_FEE_TVL_RATIO_24H * 100) === true', () => {
    const entryPct = MIN_FEE_TVL_RATIO_24H * 100
    // Shipped defaults are exit 5.54% (p10) < entry 9.42% (p25) — one dataset,
    // a documented hysteresis band (see lib/strategy-config.ts comments).
    expect(checkFeeTvlExitVsEntry(LP_FEE_TVL_EXIT_THRESHOLD, entryPct)).toBe(true)
    expect(LP_FEE_TVL_EXIT_THRESHOLD).toBeLessThan(entryPct)
  })

  it('the open gate agrees with the shipped defaults — opens allowed, no breach, no alert', async () => {
    const { gate, alertEmitted } = await enforceConfigInvariantOpenGate()
    expect(gate.ok).toBe(true)
    expect(gate.openAllowed).toBe(true)
    expect(gate.reason).toBeUndefined()
    expect(alertEmitted).toBe(false)
    expect(vi.mocked(sendAlert)).not.toHaveBeenCalled()
  })
})

describe('AC-B5.2 — fail-closed: broken pair + escape hatch unset refuses the open attempt and alerts exactly once', () => {
  it('an open attempt is refused with the invariant-blocked reason', async () => {
    const res = await attemptOpen({})
    expect(res.opened).toBe(false)
    expect(res.openBlockedReason).toBe(CONFIG_INVARIANT_BLOCK_REASON)
    expect(res.openBlockedReason).toBe('config_invariant_breach')
  })

  it('exactly ONE Telegram alert is emitted, even across repeated open attempts in the process', async () => {
    await attemptOpen({})
    await attemptOpen({})
    await attemptOpen({})
    expect(vi.mocked(sendAlert)).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendAlert).mock.calls[0][0] as { type: string; message: string }
    expect(payload.type).toBe('error')
    expect(payload.message).toContain('CONFIG INVARIANT BREACH')
    expect(payload.message).toContain('Existing positions still exit normally')
  })

  it('any value other than the exact string "true" stays fail-closed', async () => {
    for (const v of ['false', 'FALSE', '1', 'yes', '']) {
      resetConfigInvariantAlertForTests()
      const res = await attemptOpen({ ALLOW_CONFIG_INVARIANT_BREACH: v })
      expect(res.opened).toBe(false)
      expect(res.openBlockedReason).toBe(CONFIG_INVARIANT_BLOCK_REASON)
    }
  })
})

describe('AC-B5.3 — escape hatch: ALLOW_CONFIG_INVARIANT_BREACH=true warns and proceeds', () => {
  it('the bot warns and proceeds, emitting NO alert', async () => {
    const res = await attemptOpen({ ALLOW_CONFIG_INVARIANT_BREACH: 'true' })
    expect(res.opened).toBe(true)
    expect(res.openBlockedReason).toBeUndefined()
    expect(res.alertEmitted).toBe(false)
    expect(vi.mocked(sendAlert)).not.toHaveBeenCalled()
    const warned = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(warned).toContain('BREACH ALLOWED')
    expect(warned).toContain('ALLOW_CONFIG_INVARIANT_BREACH=true')
  })
})

describe('AC-B5.4 — existing positions can still exit under a breached invariant', () => {
  it('opens are refused, yet exit rule #1 still fires on a decayed Fee/TVL (exits are not gated)', async () => {
    const { gate } = await enforceConfigInvariantOpenGate(BROKEN_EXIT, BROKEN_ENTRY, {})
    expect(gate.openAllowed).toBe(false) // opens refused…

    // …but a held position whose 24h Fee/TVL has decayed (1.0% < 5.54%) still exits.
    const decayed = evaluateFeeTvlCollapseRule({
      feeTvl4hAvg: 1.0,
      sampleCount: 50,
      positionAgeHours: 3,
      thresholdPct: LP_FEE_TVL_EXIT_THRESHOLD,
    })
    expect(decayed.fire).toBe(true)
  })

  it('the exit/close money path never imports the invariant gate', () => {
    const root = process.cwd()
    for (const rel of [
      'bot/monitor.ts',
      'bot/executor/close.ts',
      'bot/executor.ts',
      'lib/fee-tvl-exit-rule.ts',
    ]) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src).not.toContain('config-invariant-gate')
      expect(src).not.toContain('CONFIG_INVARIANT_BLOCK_REASON')
    }
  })
})

describe('validateStartup behavior unchanged (non-fatal, still returns false without config)', () => {
  it('resolves to false without throwing in a hermetic (no-env) environment — the same non-fatal contract as before', async () => {
    // No RPC_URL / HELIUS / wallet env: validateStartup hits its existing
    // non-fatal paths (getConnection throws -> caught -> ok=false) and must
    // NOT throw out of the function. Behavior unchanged by the extraction.
    await expect(validateStartup('test')).resolves.toBe(false)
  })
})