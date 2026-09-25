/**
 * tests/worker-gates.test.ts
 *
 * AC-B6.1 / AC-B6.2 (audit §M2): `worker.ts` must resolve the enable/pause gate
 * from the persisted `botState` on EVERY tick, via the pure
 * `resolveEffectiveGates` — not from the module-load frozen `BOT_ENABLED`
 * constant.
 *
 *   AC-B6.1  BOT_ENABLED unset + botState.enabled=true  => tickScanner proceeds
 *   AC-B6.2  botState.enabled=false                     => BOTH ticks skip
 *
 * Hermetic: every dependency of `worker.ts` is mocked, so importing the module
 * must not start the loop, hit the network, or create a `state/` directory.
 * `BOT_ENABLED` is deliberately never set here — the whole point is that it no
 * longer matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const mocks = vi.hoisted(() => ({
  getBotState: vi.fn(),
  monitorPositions: vi.fn(),
  runScanner: vi.fn(),
  validateStartup: vi.fn(),
  retryStrandedSells: vi.fn(),
  getConnection: vi.fn(),
  flushStateWrites: vi.fn(),
  summarizeError: vi.fn((err: unknown) => String(err)),
}))

// `worker.ts` imports these with relative specifiers ('./lib/botState'); the
// '@/...' alias resolves to the same module id, so the mock applies.
vi.mock('@/lib/botState', () => ({ getBotState: mocks.getBotState }))
vi.mock('@/bot/monitor', () => ({ monitorPositions: mocks.monitorPositions }))
vi.mock('@/bot/scanner', () => ({ runScanner: mocks.runScanner }))
vi.mock('@/lib/startup-validation', () => ({ validateStartup: mocks.validateStartup }))
vi.mock('@/lib/swap', () => ({ retryStrandedSells: mocks.retryStrandedSells }))
vi.mock('@/lib/solana', () => ({ getConnection: mocks.getConnection }))
vi.mock('@/lib/local-state', () => ({ flushStateWrites: mocks.flushStateWrites }))
vi.mock('@/lib/logging', () => ({ summarizeError: mocks.summarizeError }))
// Never let the suite load a real .env.local and mutate the process env.
vi.mock('dotenv', () => ({ config: vi.fn() }))

import { tickMonitor, tickScanner } from '@/worker'

function botState(overrides: Record<string, unknown> = {}) {
  return { enabled: true, paused: false, dry_run: false, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.BOT_ENABLED
  delete process.env.BOT_DRY_RUN
  mocks.getBotState.mockResolvedValue(botState())
  mocks.monitorPositions.mockResolvedValue({ checked: 3, closed: 1 })
  mocks.runScanner.mockResolvedValue({
    scanned: 5,
    candidates: 2,
    processed: 2,
    opened: 1,
    openSkipped: 1,
    openSlots: 1,
    maxOpen: 3,
  })
  mocks.validateStartup.mockResolvedValue(true)
  mocks.retryStrandedSells.mockResolvedValue({ retried: 0, recovered: 0 })
  mocks.getConnection.mockReturnValue({})
  mocks.flushStateWrites.mockResolvedValue(undefined)
})

describe('worker.ts import is side-effect free (tests can exercise the ticks)', () => {
  it('importing the module does NOT boot the loop (no startup validation, no ticks)', () => {
    expect(mocks.validateStartup).not.toHaveBeenCalled()
    expect(mocks.monitorPositions).not.toHaveBeenCalled()
    expect(mocks.runScanner).not.toHaveBeenCalled()
  })
})

describe('AC-B6.1 — botState alone enables work (BOT_ENABLED unset)', () => {
  it('BOT_ENABLED unset + botState.enabled=true => tickScanner proceeds', async () => {
    expect(process.env.BOT_ENABLED).toBeUndefined()
    mocks.getBotState.mockResolvedValue(botState({ enabled: true, paused: false }))

    await tickScanner()

    expect(mocks.getBotState).toHaveBeenCalled()
    expect(mocks.runScanner).toHaveBeenCalledTimes(1)
  })

  it('BOT_ENABLED unset + botState.enabled=true => tickMonitor proceeds', async () => {
    expect(process.env.BOT_ENABLED).toBeUndefined()
    mocks.getBotState.mockResolvedValue(botState({ enabled: true, paused: false }))

    await tickMonitor()

    expect(mocks.getBotState).toHaveBeenCalled()
    expect(mocks.monitorPositions).toHaveBeenCalledTimes(1)
  })

  it('the gate is re-read EVERY tick, not frozen at module load: a mid-run /stop is honoured', async () => {
    mocks.getBotState
      .mockResolvedValueOnce(botState({ enabled: true }))
      .mockResolvedValueOnce(botState({ enabled: false }))

    await tickScanner()   // enabled this tick
    await tickScanner()   // /stop landed before the next tick

    expect(mocks.getBotState).toHaveBeenCalledTimes(2)
    expect(mocks.runScanner).toHaveBeenCalledTimes(1)
  })
})

describe('AC-B6.2 — botState.enabled=false skips BOTH ticks', () => {
  it('botState.enabled=false => tickMonitor and tickScanner both skip', async () => {
    mocks.getBotState.mockResolvedValue(botState({ enabled: false }))

    await tickMonitor()
    await tickScanner()

    expect(mocks.getBotState).toHaveBeenCalledTimes(2)
    expect(mocks.monitorPositions).not.toHaveBeenCalled()
    expect(mocks.runScanner).not.toHaveBeenCalled()
  })

  it('botState.paused=true also skips both ticks (paused is the same single source of truth)', async () => {
    mocks.getBotState.mockResolvedValue(botState({ enabled: true, paused: true }))

    await tickMonitor()
    await tickScanner()

    expect(mocks.monitorPositions).not.toHaveBeenCalled()
    expect(mocks.runScanner).not.toHaveBeenCalled()
  })

  it('an unreadable botState fails CLOSED: both ticks skip instead of trading', async () => {
    mocks.getBotState.mockRejectedValue(new Error('state file unreadable'))

    await tickMonitor()
    await tickScanner()

    expect(mocks.monitorPositions).not.toHaveBeenCalled()
    expect(mocks.runScanner).not.toHaveBeenCalled()
  })
})

describe('the M2 defect is gone — env no longer overrides botState', () => {
  it('BOT_ENABLED=false does NOT disable a botState the operator enabled with /start', async () => {
    process.env.BOT_ENABLED = 'false'
    mocks.getBotState.mockResolvedValue(botState({ enabled: true }))

    await tickScanner()

    expect(mocks.runScanner).toHaveBeenCalledTimes(1)
  })

  it('BOT_ENABLED=true does NOT resurrect a botState the operator stopped with /stop', async () => {
    process.env.BOT_ENABLED = 'true'
    mocks.getBotState.mockResolvedValue(botState({ enabled: false }))

    await tickMonitor()
    await tickScanner()

    expect(mocks.monitorPositions).not.toHaveBeenCalled()
    expect(mocks.runScanner).not.toHaveBeenCalled()
  })

  it('worker.ts source contains no module-load BOT_ENABLED / BOT_DRY_RUN gate', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'worker.ts'),
      'utf8',
    )
    // Strip comments so the file's own doc text (which names the env vars) cannot
    // satisfy the assertions — only real code is inspected.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('process.env.BOT_ENABLED')
    expect(code).not.toContain('process.env.BOT_DRY_RUN')
    // ...and it must resolve the gate through the shared pure resolver.
    expect(code).toContain('resolveEffectiveGates')
    // The operator hard-kills are still parsed (kept as GateFlags).
    expect(code).toContain('process.env.LP_MONITOR_ENABLED')
    expect(code).toContain('process.env.LP_SCANNER_ENABLED')
  })
})