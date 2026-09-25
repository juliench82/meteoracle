/**
 * Hermetic tests for the H3 fail-closed config-invariant open gate
 * (lib/config-invariant-gate.ts) — AC-B5.2, AC-B5.3, AC-B5.4.
 *
 * The Telegram alerter is mocked: no network, no Telegram credentials.
 * Synthetic/numeric config values only — no personal or financial data.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

vi.mock('@/bot/alerter', () => ({ sendAlert: vi.fn(async () => {}) }))

import { sendAlert } from '@/bot/alerter'
import {
  CONFIG_INVARIANT_BLOCK_REASON,
  evaluateConfigInvariantGate,
  enforceConfigInvariantOpenGate,
  resetConfigInvariantAlertForTests,
} from '@/lib/config-invariant-gate'

// Deliberately broken pair: exit (5.54) >= entry (0.5) — the exact mismatch H3 describes.
const BROKEN_EXIT = 5.54
const BROKEN_ENTRY = 0.5
// A consistent pair: exit below entry.
const OK_EXIT = 0.3
const OK_ENTRY = 0.5

const repoRoot = process.cwd()
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  resetConfigInvariantAlertForTests()
})

describe('evaluateConfigInvariantGate — pure decision layer', () => {
  it('AC-B5.2: broken pair with ALLOW_CONFIG_INVARIANT_BREACH unset => opens refused with the invariant-blocked reason', () => {
    const gate = evaluateConfigInvariantGate(BROKEN_EXIT, BROKEN_ENTRY, {})
    expect(gate.ok).toBe(false)
    expect(gate.allowBreach).toBe(false)
    expect(gate.openAllowed).toBe(false)
    expect(gate.reason).toBe(CONFIG_INVARIANT_BLOCK_REASON)
    expect(gate.reason).toBe('config_invariant_breach')
  })

  it('AC-B5.2: only the exact string "true" opts in — "false" stays fail-closed', () => {
    for (const v of ['false', 'FALSE', '1', 'yes', '']) {
      const gate = evaluateConfigInvariantGate(BROKEN_EXIT, BROKEN_ENTRY, {
        ALLOW_CONFIG_INVARIANT_BREACH: v,
      })
      expect(gate.openAllowed).toBe(false)
      expect(gate.reason).toBe(CONFIG_INVARIANT_BLOCK_REASON)
    }
  })

  it('AC-B5.3: ALLOW_CONFIG_INVARIANT_BREACH=true => open allowed (escape hatch), no block reason', () => {
    const gate = evaluateConfigInvariantGate(BROKEN_EXIT, BROKEN_ENTRY, {
      ALLOW_CONFIG_INVARIANT_BREACH: 'true',
    })
    expect(gate.ok).toBe(false)
    expect(gate.allowBreach).toBe(true)
    expect(gate.openAllowed).toBe(true)
    expect(gate.reason).toBeUndefined()
  })

  it('consistent pair (exit < entry) => opens allowed, no reason', () => {
    const gate = evaluateConfigInvariantGate(OK_EXIT, OK_ENTRY, {})
    expect(gate.ok).toBe(true)
    expect(gate.openAllowed).toBe(true)
    expect(gate.reason).toBeUndefined()
  })
})

describe('enforceConfigInvariantOpenGate — side-effect layer', () => {
  it('AC-B5.2: emits EXACTLY ONE Telegram alert even when the gate is consulted repeatedly (worker startup + scanner ticks)', async () => {
    const first = await enforceConfigInvariantOpenGate(BROKEN_EXIT, BROKEN_ENTRY, {})
    expect(first.gate.openAllowed).toBe(false)
    expect(first.alertEmitted).toBe(true)

    const second = await enforceConfigInvariantOpenGate(BROKEN_EXIT, BROKEN_ENTRY, {})
    const third = await enforceConfigInvariantOpenGate(BROKEN_EXIT, BROKEN_ENTRY, {})
    expect(second.gate.openAllowed).toBe(false)
    expect(second.alertEmitted).toBe(false)
    expect(third.alertEmitted).toBe(false)

    expect(vi.mocked(sendAlert)).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(sendAlert).mock.calls[0][0] as { type: string; message: string }
    expect(payload.type).toBe('error')
    expect(payload.message).toContain('CONFIG INVARIANT BREACH')
    expect(payload.message).toContain('ALLOW_CONFIG_INVARIANT_BREACH')
  })

  it('AC-B5.3: with ALLOW_CONFIG_INVARIANT_BREACH=true the gate proceeds and emits NO alert', async () => {
    const res = await enforceConfigInvariantOpenGate(BROKEN_EXIT, BROKEN_ENTRY, {
      ALLOW_CONFIG_INVARIANT_BREACH: 'true',
    })
    expect(res.gate.openAllowed).toBe(true)
    expect(res.alertEmitted).toBe(false)
    expect(vi.mocked(sendAlert)).not.toHaveBeenCalled()
  })

  it('consistent pair => no alert, opens allowed', async () => {
    const res = await enforceConfigInvariantOpenGate(OK_EXIT, OK_ENTRY, {})
    expect(res.gate.openAllowed).toBe(true)
    expect(res.alertEmitted).toBe(false)
    expect(vi.mocked(sendAlert)).not.toHaveBeenCalled()
  })
})

describe('AC-B5.4 — exits are never gated by the config invariant', () => {
  it('the close/monitor money path never imports the invariant gate', () => {
    for (const rel of ['bot/monitor.ts', 'bot/executor/close.ts', 'bot/executor.ts']) {
      const src = read(rel)
      expect(src).not.toContain('config-invariant-gate')
      expect(src).not.toContain('CONFIG_INVARIANT_BLOCK_REASON')
    }
  })

  it('the only consumers of the gate are the open path (worker startup + scanner)', () => {
    const consumers = [
      'worker.ts',
      'bot/scanner/deep-checker.ts',
    ].filter((rel) => read(rel).includes('config-invariant-gate'))
    expect(consumers).toEqual(['worker.ts', 'bot/scanner/deep-checker.ts'])
  })
})

describe('wiring — the gate is consumed, not fire-and-forget', () => {
  it('worker.ts awaits validateStartup and consults the gate', () => {
    const src = read('worker.ts')
    expect(src).toContain('await validateStartup(')
    expect(src).toContain('await enforceConfigInvariantOpenGate()')
    // the old fire-and-forget form must be gone
    expect(src).not.toContain("validateStartup('worker').catch(() => {}).then(")
  })

  it('the scanner open gate returns gate.reason as openBlockedReason', () => {
    const src = read('bot/scanner/deep-checker.ts')
    expect(src).toContain('await enforceConfigInvariantOpenGate()')
    expect(src).toContain('openBlockedReason: gate.reason')
  })
})