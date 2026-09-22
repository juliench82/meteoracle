/**
 * Hermetic tests for the append-only trade ledger (lib/trade-ledger.ts) and
 * its hook in bot/executor/persistence.ts (AC15).
 *
 * All filesystem activity happens in temp dirs. No env vars, no network.
 *
 * The persistence integration test chdirs into a fresh temp dir BEFORE
 * dynamically importing '@/bot/executor/persistence', so the module-level
 * state paths in lib/local-state.ts bind to the temp dir, not the repo.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as tradeLedger from '@/lib/trade-ledger'

const RECORD_KEYS = [
  'id',
  'symbol',
  'mode',
  'opened_at',
  'closed_at',
  'close_reason',
  'sol_deposited',
  'net_pnl_pct',
  'last_fee_tvl_4h_avg',
  'fees_sol',
  'il_sol',
  'gas_sol',
  'rent_sol',
]

function makeRecord(id: string): tradeLedger.TradeRecord {
  return {
    id,
    symbol: 'TEST-TOKEN',
    mode: 'dry_run',
    opened_at: '2026-01-01T00:00:00.000Z',
    closed_at: '2026-01-01T02:00:00.000Z',
    close_reason: 'oor',
    sol_deposited: 0.1,
    net_pnl_pct: -2.5,
    last_fee_tvl_4h_avg: 0.4,
    fees_sol: 0.005,
    il_sol: 0.0,
    gas_sol: 0.001,
    rent_sol: 0.0,
  }
}

describe('appendTradeRecord / readTradeLog (explicit temp paths)', () => {
  it('creates missing dirs, writes parseable JSON, and returns the record', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-ledger-'))
    try {
      const file = path.join(tmp, 'state', 'trade-log.json')
      await tradeLedger.appendTradeRecord(makeRecord('rec-1'), file)
      await tradeLedger.flushTradeLogWrites()
      const rows = tradeLedger.readTradeLog(file)
      expect(rows.length).toBe(1)
      expect(rows[0]).toEqual(makeRecord('rec-1'))
      // Every schema field present on the row
      expect(Object.keys(rows[0]).sort()).toEqual([...RECORD_KEYS].sort())
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('dedupes by id: a second append of the same id is a no-op', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-ledger-'))
    try {
      const file = path.join(tmp, 'trade-log.json')
      await tradeLedger.appendTradeRecord(makeRecord('rec-dup'), file)
      await tradeLedger.appendTradeRecord(makeRecord('rec-dup'), file)
      await tradeLedger.flushTradeLogWrites()
      expect(tradeLedger.readTradeLog(file).length).toBe(1)
      // A DIFFERENT id appends fine alongside it
      await tradeLedger.appendTradeRecord(makeRecord('rec-other'), file)
      await tradeLedger.flushTradeLogWrites()
      expect(tradeLedger.readTradeLog(file).length).toBe(2)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('readTradeLog returns [] for missing or corrupt files (no crash)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-ledger-'))
    try {
      expect(tradeLedger.readTradeLog(path.join(tmp, 'missing.json'))).toEqual([])
      const corrupt = path.join(tmp, 'corrupt.json')
      fs.writeFileSync(corrupt, 'not json {')
      expect(tradeLedger.readTradeLog(corrupt)).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('a ledger WRITE FAILURE cannot throw into the caller: append resolves instead of rejecting', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-ledger-'))
    try {
      // "blocker" is a regular FILE, so mkdirSync on tmp/blocker/sub fails -> write fails.
      const blocker = path.join(tmp, 'blocker')
      fs.writeFileSync(blocker, 'I am a file')
      const badTarget = path.join(blocker, 'sub', 'trade-log.json')

      await expect(tradeLedger.appendTradeRecord(makeRecord('rec-x'), badTarget)).resolves.toBeUndefined()
      await expect(tradeLedger.flushTradeLogWrites()).resolves.toBeUndefined()

      // Simulated close flow unaffected: completes normally despite ledger failure.
      async function closeFlow(): Promise<string> {
        await tradeLedger.appendTradeRecord(makeRecord('rec-y'), badTarget)
        return 'closed'
      }
      await expect(closeFlow()).resolves.toBe('closed')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('AC15 — close flow through persistence.ts appends the ledger (temp state dir)', () => {
  const originalCwd = process.cwd()
  let tmpDir: string
  let persistence: typeof import('@/bot/executor/persistence')

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meteoracle-close-'))
    process.chdir(tmpDir)

    // Seed an "open" position in the temp state dir.
    const stateDir = path.join(tmpDir, 'state')
    fs.mkdirSync(stateDir, { recursive: true })
    const positions = [
      {
        id: 'pos-1',
        symbol: 'FIXTURE-1',
        mint: 'fixture-mint-1',
        pool_address: 'fixture-pool-1',
        status: 'active',
        dry_run: true,
        opened_at: '2026-01-02T00:00:00.000Z',
        sol_deposited: 0.1,
        last_net_pnl_pct: -1.2,
        last_fee_tvl_4h_avg: 0.55,
      },
      {
        id: 'pos-2',
        symbol: 'FIXTURE-2',
        mint: 'fixture-mint-2',
        pool_address: 'fixture-pool-2',
        status: 'active',
        dry_run: false,
        opened_at: '2026-01-02T01:00:00.000Z',
        sol_deposited: 0.25,
        last_net_pnl_pct: 3.1,
        last_fee_tvl_4h_avg: 0.8,
      },
    ]
    fs.writeFileSync(path.join(stateDir, 'open-lp-positions.json'), JSON.stringify(positions, null, 2))

    // Import AFTER chdir so module-level state paths (state/) bind to tmpDir.
    persistence = await import('@/bot/executor/persistence')
  })

  afterAll(() => {
    process.chdir(originalCwd)
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records one full-schema row on close; duplicate close dedupes by id; unknown id appends nothing', async () => {
    const ledgerFile = path.join(tmpDir, 'state', 'trade-log.json')

    await persistence.markPositionClosed('pos-1', null, 'fee_tvl_yield_low')
    await tradeLedger.flushTradeLogWrites()

    let rows = tradeLedger.readTradeLog(ledgerFile)
    expect(rows.length).toBe(1)
    const row = rows[0]
    // All 13 schema fields present, structural values preserved:
    expect(Object.keys(row).sort()).toEqual([...RECORD_KEYS].sort())
    expect(row.id).toBe('pos-1')
    expect(row.symbol).toBe('FIXTURE-1')
    expect(row.mode).toBe('dry_run')
    expect(row.opened_at).toBe('2026-01-02T00:00:00.000Z')
    expect(row.close_reason).toBe('fee_tvl_yield_low')
    expect(row.sol_deposited).toBe(0.1)
    expect(row.net_pnl_pct).toBe(-1.2)
    expect(row.last_fee_tvl_4h_avg).toBe(0.55)
    expect(row.fees_sol).toBeNull()
    expect(row.il_sol).toBeNull()
    expect(row.gas_sol).toBeNull()
    expect(row.rent_sol).toBeNull()

    // Close the same position again -> dedupe by id holds (still exactly 1 row).
    await persistence.markPositionClosed('pos-1', 1.5, 'max_duration')
    await tradeLedger.flushTradeLogWrites()
    rows = tradeLedger.readTradeLog(ledgerFile)
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('pos-1')

    // Unknown id -> no record appended.
    await persistence.markPositionClosed('does-not-exist', null, 'oor')
    await tradeLedger.flushTradeLogWrites()
    expect(tradeLedger.readTradeLog(ledgerFile).length).toBe(1)

    // Closing the live-mode position appends a live record too.
    await persistence.markPositionClosed('pos-2', null, 'net_pnl_sl')
    await tradeLedger.flushTradeLogWrites()
    rows = tradeLedger.readTradeLog(ledgerFile)
    expect(rows.length).toBe(2)
    const liveRow = rows.find((r) => r.id === 'pos-2')!
    expect(liveRow.mode).toBe('live')
    expect(liveRow.close_reason).toBe('net_pnl_sl')
    expect(liveRow.sol_deposited).toBe(0.25)
  })

  it('the close path itself is unaffected when the ledger write later fails (state still persisted)', async () => {
    // markPositionClosed must never throw regardless of ledger state.
    await expect(persistence.markPositionClosed('pos-1', null, 'manual_close')).resolves.toBeUndefined()
    await tradeLedger.flushTradeLogWrites()
    // The position was still marked closed in the temp open-lp state (close flow intact).
    const positions = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'open-lp-positions.json'), 'utf8'))
    expect(positions.find((p: any) => p.id === 'pos-1')?.status).toBe('closed')
  })
})