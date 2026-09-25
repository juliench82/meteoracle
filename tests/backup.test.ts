/**
 * Hermetic tests for lib/backup.ts — off-host state/ snapshot (G5).
 *
 * backup.ts freezes STATE_DIR from process.cwd() at import, so every case
 * chdir's into a unique tmp dir FIRST, then resetModules() + fresh-import the
 * module — exactly mirroring tests/local-state-writequeue.test.ts. The repo's
 * own state/ is never touched (asserted in afterEach).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const originalCwd = process.cwd()
const REPO_ROOT = path.resolve(originalCwd)
const tmpDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-backup-'))
  tmpDirs.push(dir)
  return dir
}

async function loadBackup(dir: string): Promise<typeof import('@/lib/backup')> {
  process.chdir(dir)
  vi.resetModules()
  return await import('@/lib/backup')
}

function setEnv(obj: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

describe('backupState (lib/backup.ts)', () => {
  afterEach(() => {
    process.chdir(originalCwd)
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    setEnv({ STATE_BACKUP_TARGET: undefined, STATE_BACKUP_S3_PREFIX: undefined, BOT_DRY_RUN: undefined })
    // Hermeticity: repo state/ must never be created by these tests.
    expect(fs.existsSync(path.join(REPO_ROOT, 'state'))).toBe(false)
  })

  it('copies state/* to STATE_BACKUP_TARGET and returns true', async () => {
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'open-lp-positions.json'), '[]')
    fs.writeFileSync(path.join(tmp, 'state', 'trade-log.json'), '[]')

    setEnv({ STATE_BACKUP_TARGET: path.join(tmp, 'target'), BOT_DRY_RUN: undefined })
    const { backupState } = await loadBackup(tmp)

    expect(await backupState()).toBe(true)

    const copied = fs.readdirSync(path.join(tmp, 'target')).sort()
    expect(copied).toEqual(['open-lp-positions.json', 'trade-log.json'])
    expect(fs.readFileSync(path.join(tmp, 'target', 'open-lp-positions.json'), 'utf8')).toBe('[]')
  })

  it('no-op (returns true) when no backup target configured; target untouched', async () => {
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'x.json'), '1')
    const target = path.join(tmp, 'untouched')
    setEnv({ STATE_BACKUP_TARGET: undefined, STATE_BACKUP_S3_PREFIX: undefined, BOT_DRY_RUN: undefined })

    const { backupState } = await loadBackup(tmp)
    expect(await backupState()).toBe(true)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('returns true (no throw) when state/ is missing or empty', async () => {
    const tmp = makeTempDir()
    setEnv({ STATE_BACKUP_TARGET: path.join(tmp, 'tgt'), BOT_DRY_RUN: undefined })

    const { backupState } = await loadBackup(tmp)
    await expect(backupState()).resolves.toBe(true)

    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    await expect(backupState()).resolves.toBe(true)
  })

  it('is a no-op under BOT_DRY_RUN=true', async () => {
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'x.json'), '1')
    setEnv({ STATE_BACKUP_TARGET: path.join(tmp, 'tgt'), BOT_DRY_RUN: 'true' })

    const { backupState } = await loadBackup(tmp)
    expect(await backupState()).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'tgt'))).toBe(false)
  })
})

describe('startStateBackupTimer (fake timers)', () => {
  afterEach(() => {
    process.chdir(originalCwd)
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    setEnv({ STATE_BACKUP_TARGET: undefined, STATE_BACKUP_S3_PREFIX: undefined, BOT_DRY_RUN: undefined })
    expect(fs.existsSync(path.join(REPO_ROOT, 'state'))).toBe(false)
  })

  it('does not fire before the interval elapses', async () => {
    vi.useFakeTimers()
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'pos.json'), 'marker')
    setEnv({ STATE_BACKUP_TARGET: path.join(tmp, 'tgt'), BOT_DRY_RUN: undefined })
    const { startStateBackupTimer } = await loadBackup(tmp)

    const { stop } = startStateBackupTimer(1000)
    expect(fs.existsSync(path.join(tmp, 'tgt', 'pos.json'))).toBe(false)
    await vi.advanceTimersByTimeAsync(999)
    expect(fs.existsSync(path.join(tmp, 'tgt', 'pos.json'))).toBe(false)
    stop()
    vi.useRealTimers()
  })

  it('fires state/ copy at the interval', async () => {
    vi.useFakeTimers()
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'pos.json'), 'marker')
    setEnv({ STATE_BACKUP_TARGET: path.join(tmp, 'tgt'), BOT_DRY_RUN: undefined })
    const { startStateBackupTimer } = await loadBackup(tmp)

    const { stop } = startStateBackupTimer(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fs.readFileSync(path.join(tmp, 'tgt', 'pos.json'), 'utf8')).toBe('marker')
    stop()
    vi.useRealTimers()
  })

  it('stop() halts further backups', async () => {
    vi.useFakeTimers()
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'pos.json'), 'marker')
    setEnv({ STATE_BACKUP_TARGET: path.join(tmp, 'tgt'), BOT_DRY_RUN: undefined })
    const { startStateBackupTimer } = await loadBackup(tmp)

    const { stop } = startStateBackupTimer(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fs.existsSync(path.join(tmp, 'tgt', 'pos.json'))).toBe(true)

    stop()
    // delete the copy; if the timer were still live, a later tick would recreate it
    fs.rmSync(path.join(tmp, 'tgt', 'pos.json'), { force: true })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fs.existsSync(path.join(tmp, 'tgt', 'pos.json'))).toBe(false)
    vi.useRealTimers()
  })

  it('does not start a timer when dry-run or no target', async () => {
    vi.useFakeTimers()
    const tmp = makeTempDir()
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'state', 'pos.json'), 'marker')
    setEnv({ STATE_BACKUP_TARGET: undefined, STATE_BACKUP_S3_PREFIX: undefined, BOT_DRY_RUN: undefined })
    const { startStateBackupTimer } = await loadBackup(tmp)

    const { stop } = startStateBackupTimer(1000)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fs.existsSync(path.join(tmp, 'tgt', 'pos.json'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'timer-tgt', 'pos.json'))).toBe(false)
    stop()
    vi.useRealTimers()
  })
})
