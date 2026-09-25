/**
 * Hermetic tests for the effective-gate resolver (lib/gates.ts).
 *
 * AC-B6.3: `resolveEffectiveGates` covers env seed only, botState override,
 * paused, `dryRunPinnedByEnv` true/false, and the operator hard-kill flags.
 *
 * No network, no clock, no env mutation: the function is pure and the caller
 * supplies botState/env/flags.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveEffectiveGates } from '@/lib/gates'
import type { BotState } from '@/lib/botState'

/** A botState as persisted when the operator last used /start (enabled, live). */
function state(overrides: Partial<BotState> = {}): Pick<BotState, 'enabled' | 'paused' | 'dry_run'> {
  return {
    enabled: true,
    paused: false,
    dry_run: false,
    ...overrides,
  }
}

describe('resolveEffectiveGates — botState is the single source of truth', () => {
  it('AC-B6.1: BOT_ENABLED unset + botState.enabled=true (after /start) => enabled', () => {
    expect(resolveEffectiveGates(state({ enabled: true }), {}, {})).toMatchObject({ enabled: true, paused: false })
  })

  it('AC-B6.3 (env seed only): BOT_ENABLED=true does NOT enable a botState that is disabled', () => {
    // `/stop` wrote enabled=false; the stale boot seed must not resurrect work.
    const gates = resolveEffectiveGates(state({ enabled: false }), { BOT_ENABLED: 'true' }, {})
    expect(gates.enabled).toBe(false)
  })

  it('AC-B6.3 (botState override): BOT_ENABLED=false does NOT disable a botState that is enabled', () => {
    // `/start` wrote enabled=true; a process seeded with BOT_ENABLED=false must obey botState.
    const gates = resolveEffectiveGates(state({ enabled: true }), { BOT_ENABLED: 'false' }, {})
    expect(gates.enabled).toBe(true)
  })

  it('AC-B6.2: botState.enabled=false (after /stop) => not enabled', () => {
    expect(resolveEffectiveGates(state({ enabled: false }), {}, {}).enabled).toBe(false)
  })
})

describe('resolveEffectiveGates — paused', () => {
  it('AC-B6.3: paused=true disables work even when enabled=true, and reports paused', () => {
    const gates = resolveEffectiveGates(state({ enabled: true, paused: true }), {}, {})
    expect(gates.enabled).toBe(false)
    expect(gates.paused).toBe(true)
  })

  it('paused is reported verbatim from botState (absent => false)', () => {
    expect(resolveEffectiveGates(state({ paused: undefined }), {}, {}).paused).toBe(false)
    expect(resolveEffectiveGates(state({ paused: false }), {}, {}).paused).toBe(false)
  })

  it('paused does not leak into the dry-run flags', () => {
    const gates = resolveEffectiveGates(state({ enabled: false, paused: true, dry_run: false }), {}, {})
    expect(gates.dryRun).toBe(false)
    expect(gates.dryRunPinnedByEnv).toBe(false)
  })
})

describe('resolveEffectiveGates — dry-run and the env pin (AC-B6.3)', () => {
  it('dryRunPinnedByEnv=false when BOT_DRY_RUN is unset; botState.dry_run decides', () => {
    expect(resolveEffectiveGates(state({ dry_run: false }), {}, {})).toEqual({
      enabled: true,
      paused: false,
      dryRun: false,
      dryRunPinnedByEnv: false,
    })
    expect(resolveEffectiveGates(state({ dry_run: true }), {}, {}).dryRun).toBe(true)
  })

  it('dryRunPinnedByEnv=true when BOT_DRY_RUN===\'true\', and it forces dry-run on', () => {
    const gates = resolveEffectiveGates(state({ dry_run: false }), { BOT_DRY_RUN: 'true' }, {})
    expect(gates.dryRunPinnedByEnv).toBe(true)
    expect(gates.dryRun).toBe(true)
  })

  it('the pin is a strict match — only the exact string \'true\' pins (no case/whitespace tolerance)', () => {
    for (const value of ['TRUE', 'True', ' true', 'true ', '1', 'yes', 'false', '']) {
      const gates = resolveEffectiveGates(state({ dry_run: false }), { BOT_DRY_RUN: value }, {})
      expect(gates.dryRunPinnedByEnv, `BOT_DRY_RUN=${JSON.stringify(value)}`).toBe(false)
      expect(gates.dryRun).toBe(false)
    }
  })

  it('BOT_DRY_RUN=false does not un-pin or clear a persisted dry_run=true', () => {
    const gates = resolveEffectiveGates(state({ dry_run: true }), { BOT_DRY_RUN: 'false' }, {})
    expect(gates.dryRunPinnedByEnv).toBe(false)
    expect(gates.dryRun).toBe(true)
  })
})

describe('resolveEffectiveGates — operator hard-kills (AC-B6.3)', () => {
  it('monitorEnabled=false hard-kills work', () => {
    expect(resolveEffectiveGates(state(), {}, { monitorEnabled: false }).enabled).toBe(false)
  })

  it('scannerEnabled=false hard-kills work', () => {
    expect(resolveEffectiveGates(state(), {}, { scannerEnabled: false }).enabled).toBe(false)
  })

  it('a hard-kill is a STREAM gate: resolving the scanner with only the scanner flag is untouched by the monitor kill (and vice versa)', () => {
    // Mirrors worker.ts: tickMonitor passes { monitorEnabled }, tickScanner passes { scannerEnabled }.
    expect(resolveEffectiveGates(state(), {}, { monitorEnabled: true }).enabled).toBe(true)
    expect(resolveEffectiveGates(state(), {}, { scannerEnabled: true }).enabled).toBe(true)
    // only the stream it belongs to is killed
    expect(resolveEffectiveGates(state(), {}, { monitorEnabled: false }).enabled).toBe(false)
    expect(resolveEffectiveGates(state(), {}, { scannerEnabled: false }).enabled).toBe(false)
  })

  it('an absent hard-kill flag means "not killed" (LP_*_ENABLED unset => enabled)', () => {
    expect(resolveEffectiveGates(state(), {}, { monitorEnabled: undefined, scannerEnabled: undefined }).enabled).toBe(true)
  })

  it('a hard-kill cannot be overridden by botState.enabled=true, and does not change dryRun', () => {
    const gates = resolveEffectiveGates(state({ enabled: true }), {}, { scannerEnabled: false })
    expect(gates.enabled).toBe(false)
    expect(gates.dryRun).toBe(false)
  })
})

describe('resolveEffectiveGates — purity / env-role compliance', () => {
  it('the module reads no global env and imports only the BotState type (hard-kills stay operator-driven)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'gates.ts'),
      'utf8',
    )
    // Strip comments so the module's own documentation (which names the env vars)
    // cannot satisfy this assertion — only real code is inspected.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    // It must never consult process.env itself: env is passed in by the caller.
    expect(code).not.toContain('process.env')
    // Type-only import: no runtime dependency on the filesystem-backed botState module.
    expect(src).toContain("import type { BotState } from './botState'")
  })
})