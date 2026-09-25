/**
 * Hermetic tests for the M4 close-in-progress handling in the live close path
 * (bot/executor/close.ts, bot/executor/persistence.ts).
 *
 * AC-B1.1 — the close persistence helper clears the canonical `oor_since`
 *           (and `oor_since_at` no longer exists anywhere in the source tree).
 * AC-B1.3 — a close attempted while a fresh persisted marker exists performs NO
 *           on-chain call and leaves the marker in place (close-tx path mocked).
 *
 * Everything runs in a temp cwd with temp state files. The Solana / DLMM / tx
 * modules are mocked, so there is no network, no RPC and no wallet env.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Repo root captured before any chdir (used by the AC-B1.1 source sweep).
const REPO_ROOT = process.cwd()

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(() => ({})),
  getWallet: vi.fn(() => ({ publicKey: { toBase58: () => 'fixture-wallet' } })),
  getPriorityFee: vi.fn(async () => 0),
  simulateAndCheck: vi.fn(),
  sendLegacyTx: vi.fn(async () => 'fixture-sig'),
  applyPriorityFee: vi.fn((tx: unknown) => tx),
  getDLMM: vi.fn(async () => ({ create: vi.fn() })),
  sendAlert: vi.fn(async () => {}),
  resolveSolPriceUsd: vi.fn(async () => 150),
}))

vi.mock('@/lib/solana', () => ({
  getConnection: mocks.getConnection,
  getWallet: mocks.getWallet,
  getPriorityFee: mocks.getPriorityFee,
}))

vi.mock('@/lib/solana-tx', () => ({
  simulateAndCheck: mocks.simulateAndCheck,
  sendLegacyTx: mocks.sendLegacyTx,
  applyPriorityFee: mocks.applyPriorityFee,
}))

vi.mock('@/bot/executor/utils', () => ({
  getDLMM: mocks.getDLMM,
  getTokenProgramId: vi.fn(),
  getPositionWithRetry: vi.fn(),
  getClaimableFeesUsd: vi.fn(() => 0),
  getDecimalAdjustedPrice: vi.fn(() => 0),
  NATIVE_MINT_STR: 'So11111111111111111111111111111111111111112',
  TOKEN_2022_PROGRAM_ID: { toBase58: () => 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
  TOKEN_PROGRAM_ID: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
}))

vi.mock('@/bot/alerter', () => ({ sendAlert: mocks.sendAlert }))
vi.mock('@/lib/sol-price', () => ({ resolveSolPriceUsd: mocks.resolveSolPriceUsd }))

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Production source only: node_modules/build output and the test suite itself
    // (which legitimately mentions the removed field name in negative assertions).
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name === 'tests') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('AC-B1.1 — the close persistence helper clears the canonical oor_since', () => {
  const originalCwd = process.cwd()
  let tmpDir: string
  let persistence: typeof import('@/bot/executor/persistence')

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-oorclear-'))
    process.chdir(tmpDir)
    const stateDir = path.join(tmpDir, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, 'open-lp-positions.json'),
      JSON.stringify(
        [
          {
            id: 'pos-oor',
            symbol: 'FIXTURE-OOR',
            mint: 'fixture-mint-oor',
            pool_address: 'fixture-pool-oor',
            status: 'active',
            dry_run: true,
            opened_at: '2026-01-02T00:00:00.000Z',
            sol_deposited: 0.1,
            oor_since: '2026-01-02T01:00:00.000Z',
          },
          {
            id: 'pos-sellfail',
            symbol: 'FIXTURE-SF',
            mint: 'fixture-mint-sf',
            pool_address: 'fixture-pool-sf',
            status: 'active',
            dry_run: true,
            opened_at: '2026-01-02T00:00:00.000Z',
            sol_deposited: 0.2,
            oor_since: '2026-01-02T02:00:00.000Z',
          },
        ],
        null,
        2,
      ),
    )
    persistence = await import('@/bot/executor/persistence')
  })

  afterAll(() => {
    process.chdir(originalCwd)
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('markPositionClosed clears oor_since (null) and writes no oor_since_at', async () => {
    await persistence.markPositionClosed('pos-oor', null, 'oor_test')
    const rows = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'open-lp-positions.json'), 'utf8'))
    const row = rows.find((r: any) => r.id === 'pos-oor')
    expect(row.status).toBe('closed')
    expect(row.oor_since).toBeNull()
    expect('oor_since_at' in row).toBe(false)
  })

  it('markPositionSellFailed clears oor_since (null) and writes no oor_since_at', async () => {
    await persistence.markPositionSellFailed('pos-sellfail', null, 'sell_failed_test')
    const rows = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'open-lp-positions.json'), 'utf8'))
    const row = rows.find((r: any) => r.id === 'pos-sellfail')
    expect(row.status).toBe('sell_failed')
    expect(row.oor_since).toBeNull()
    expect('oor_since_at' in row).toBe(false)
  })

  it('no source file writes oor_since_at or a boolean close_in_progress (regression sweep)', () => {
    const offenders: string[] = []
    for (const file of walkTs(REPO_ROOT)) {
      const src = fs.readFileSync(file, 'utf8')
      const rel = path.relative(REPO_ROOT, file)
      if (src.includes('oor_since_at')) offenders.push(`${rel}: oor_since_at`)
      if (/close_in_progress\s*:\s*(true|false)/.test(src)) offenders.push(`${rel}: boolean close_in_progress`)
    }
    expect(offenders).toEqual([])
  })
})

describe('AC-B1.3 — a close with a fresh marker performs no on-chain call', () => {
  const originalCwd = process.cwd()
  let tmpDir: string
  let closePosition: (positionId: string, reason: string) => Promise<boolean>

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-closeguard-'))
    process.chdir(tmpDir)
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true })

    // A close that another (possibly restarted) process started moments ago.
    fs.writeFileSync(
      path.join(tmpDir, 'state', 'open-lp-positions.json'),
      JSON.stringify(
        [
          {
            id: 'pos-fresh',
            symbol: 'FIXTURE-FRESH',
            mint: 'fixture-mint-fresh',
            pool_address: 'fixture-pool-fresh',
            position_pubkey: 'fixture-position-pubkey',
            status: 'active',
            dry_run: false,
            sol_deposited: 0.1,
            opened_at: '2026-01-02T00:00:00.000Z',
            close_in_progress_at: new Date().toISOString(),
          },
        ],
        null,
        2,
      ),
    )

    vi.stubEnv('BOT_DRY_RUN', 'false')
    const mod = await import('@/bot/executor/close')
    closePosition = mod.closePosition
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    process.chdir(originalCwd)
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns false, makes no on-chain call, and leaves the marker for the other closer', async () => {
    mocks.getConnection.mockClear()
    mocks.getWallet.mockClear()
    mocks.getDLMM.mockClear()
    mocks.sendLegacyTx.mockClear()

    const result = await closePosition('pos-fresh', 'oor_test')

    expect(result).toBe(false)
    expect(mocks.getConnection).not.toHaveBeenCalled()
    expect(mocks.getWallet).not.toHaveBeenCalled()
    expect(mocks.getDLMM).not.toHaveBeenCalled()
    expect(mocks.sendLegacyTx).not.toHaveBeenCalled()

    const rows = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'open-lp-positions.json'), 'utf8'))
    const row = rows.find((r: any) => r.id === 'pos-fresh')
    // This attempt did not own the close, so the marker must survive and the row stays open.
    expect(row.close_in_progress_at).toBeTruthy()
    expect(row.status).toBe('active')
  })
})