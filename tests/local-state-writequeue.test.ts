/**
 * Hermetic fault-injection tests for the local-state write queue (lib/local-state.ts).
 *
 * Reproduces the audit's §H2 experiment ("one transient disk error poisons the
 * write queue") against the SOURCE module:
 *   - `@/lib/atomic-write` is mocked, and the mock can be told to fail N times
 *     (simulating a transient ENOSPC from `renameSync`) before delegating to the
 *     real writer;
 *   - `@/bot/alerter` is mocked so the 3-strike pause path is observable without
 *     any network.
 *
 * Hermetic: every case runs in its own os.tmpdir() directory (process.chdir
 * before the module is imported, so `state/` never touches the repo), no network,
 * no wallet, no RPC, no .env.local, no new dependency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OpenLpPosition } from '@/lib/local-state'

/** Failure injection shared with the hoisted module mocks. */
const control = vi.hoisted(() => ({ failuresLeft: 0 }))

vi.mock('@/lib/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/atomic-write')>()
  return {
    atomicWriteJson: vi.fn((filePath: string, data: unknown) => {
      // Simulate a transient disk error (ENOSPC/EIO) on rename.
      if (control.failuresLeft > 0) {
        control.failuresLeft--
        throw new Error('ENOSPC: no space left on device (injected)')
      }
      return actual.atomicWriteJson(filePath, data)
    }),
  }
})

vi.mock('@/bot/alerter', () => ({
  sendAlert: vi.fn(async () => undefined),
}))

// Stub botState so the 3-strike pause path never touches the real module (which
// would resolve state/ from whatever cwd is current when the dynamic import
// settles). Also lets us assert the pause write directly.
vi.mock('@/lib/botState', () => ({
  setBotState: vi.fn(async () => undefined),
}))

const originalCwd = process.cwd()
const tmpDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-writequeue-'))
  tmpDirs.push(dir)
  return dir
}

/**
 * Load a FRESH copy of lib/local-state (module-level writeQueue + failure
 * counter reset) rooted at a temp dir, plus the mock handles for assertions.
 */
async function loadLocalState(dir: string) {
  process.chdir(dir)
  vi.resetModules()
  const mod = await import('@/lib/local-state')
  const atomicMod = await import('@/lib/atomic-write')
  const alerterMod = await import('@/bot/alerter')
  const botStateMod = await import('@/lib/botState')
  return {
    mod,
    atomicWriteJson: vi.mocked(atomicMod.atomicWriteJson),
    sendAlert: vi.mocked(alerterMod.sendAlert),
    setBotState: vi.mocked(botStateMod.setBotState),
    stateFile: path.join(dir, 'state', 'open-lp-positions.json'),
  }
}

function makePosition(id: string, extra: Record<string, unknown> = {}): OpenLpPosition {
  return {
    id,
    symbol: id,
    mint: `mint-${id}`,
    pool_address: `pool-${id}`,
    position_pubkey: '',
    strategy_id: 'evil-panda',
    sol_deposited: 0.1,
    status: 'active',
    ...extra,
  }
}

function readStateFile(stateFile: string): OpenLpPosition[] {
  if (!fs.existsSync(stateFile)) return []
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'))
}

beforeEach(() => {
  control.failuresLeft = 0
})

afterEach(() => {
  process.chdir(originalCwd)
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('local-state write queue — H2 fault injection', () => {
  it('AC-B2.1: one transient failure, then a healthy retry — the retry mutator RUNS and the file gets the update', async () => {
    const { mod, stateFile } = await loadLocalState(makeTempDir())

    control.failuresLeft = 1
    await expect(
      mod.withQueuedUpdate((positions) => { positions.push(makePosition('D')) })
    ).rejects.toThrow('ENOSPC')

    // The failed write genuinely did not land.
    expect(readStateFile(stateFile)).toEqual([])

    // Retry on a HEALTHY disk: before the fix this mutator was skipped entirely
    // (rejected promise stored back into writeQueue) and the write was lost.
    await mod.withQueuedUpdate((positions) => { positions.push(makePosition('D')) })

    const onDisk = readStateFile(stateFile)
    expect(onDisk.map((p) => p.id)).toEqual(['D'])
    expect(onDisk[0].symbol).toBe('D')
  })

  it('AC-B2.3: a failure on one call does not suppress the mutator of any subsequent call (poisoned-queue regression)', async () => {
    const { mod, stateFile } = await loadLocalState(makeTempDir())

    await mod.withQueuedUpdate((positions) => { positions.push(makePosition('A')) })

    let mutatorRuns = 0
    control.failuresLeft = 1
    await expect(mod.withQueuedUpdate(() => { mutatorRuns++ })).rejects.toThrow('ENOSPC')
    expect(mutatorRuns).toBe(1)

    // The next call must run ITS OWN mutator — the queue can no longer be poisoned.
    await mod.withQueuedUpdate(() => { mutatorRuns++ })
    expect(mutatorRuns).toBe(2)

    // And a different entry point is equally unaffected.
    await mod.applyMonitorUpdates([{ id: 'A', patch: { symbol: 'UPDATED' } }])
    expect(readStateFile(stateFile)[0].symbol).toBe('UPDATED')
  })

  it('AC-B2.2: 1 failure then 1 success resets the counter; pause+alert needs 3 genuinely consecutive failures', async () => {
    const { mod, sendAlert, setBotState } = await loadLocalState(makeTempDir())

    // Failure #1 of the streak — no pause yet.
    control.failuresLeft = 1
    await expect(mod.withQueuedUpdate(() => {})).rejects.toThrow('ENOSPC')
    expect(sendAlert).not.toHaveBeenCalled()

    // A success resets the counter.
    await mod.withQueuedUpdate(() => {})
    expect(sendAlert).not.toHaveBeenCalled()

    // Two genuinely consecutive failures after the reset — still no pause.
    control.failuresLeft = 2
    await expect(mod.withQueuedUpdate(() => {})).rejects.toThrow('ENOSPC')
    await expect(mod.withQueuedUpdate(() => {})).rejects.toThrow('ENOSPC')
    expect(sendAlert).not.toHaveBeenCalled()

    // The third genuinely consecutive failure trips the pause + alert exactly once.
    control.failuresLeft = 1
    await expect(mod.withQueuedUpdate(() => {})).rejects.toThrow('ENOSPC')
    expect(sendAlert).toHaveBeenCalledTimes(1)
    const payload = sendAlert.mock.calls[0][0] as { type: string; message: string }
    expect(payload.type).toBe('error')
    expect(payload.message).toContain('3+ times')

    // ...and the pause write was issued (fire-and-forget: give the microtasks a tick).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setBotState).toHaveBeenCalledWith({ paused: true })
  })

  it('AC-B2.4: saveOpenLpPositions returns a promise that rejects on genuine failure and resolves on success', async () => {
    const { mod, stateFile } = await loadLocalState(makeTempDir())
    const positions = [makePosition('X')]

    control.failuresLeft = 1
    const failed = mod.saveOpenLpPositions(positions)
    expect(failed).toBeInstanceOf(Promise) // no more void-swallow
    await expect(failed).rejects.toThrow('ENOSPC')
    expect(fs.existsSync(stateFile)).toBe(false)

    await expect(mod.saveOpenLpPositions(positions)).resolves.toBeUndefined()
    expect(readStateFile(stateFile).map((p) => p.id)).toEqual(['X'])

    // The queue is healthy afterwards.
    await expect(mod.flushStateWrites()).resolves.toBeUndefined()
  })
})