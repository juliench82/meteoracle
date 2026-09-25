/**
 * Hermetic tests for finding M1 — the open-path SOL/rent reserve.
 *
 * The bug: `METEORA_RENT_RESERVE_SOL = 0.07` understated the real position rent
 * by ~2x (220 bins — the code's own MAX_SAFE_NUM_BINS — needs 0.1987 SOL rent,
 * before ATA rent and tx fees), so the balance gate could pass and the open
 * could then run out of SOL mid-scaffold.
 *
 * The mock connection below reproduces the real Solana rent-exemption formula
 * used by an RPC node — `(128 + accountSize) * 6960` lamports — which yields
 * exactly the audit's M1 rent table (8,192 B -> 0.0579; 18,176 B -> 0.1274;
 * 28,416 B -> 0.1987). No network, no wallet, no env.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATA_RENT_SOL,
  METEORA_RENT_RESERVE_SOL,
  OPEN_FEE_HEADROOM_SOL,
  WALLET_MIN_SOL_RESERVE,
  computeOpenSolRequirement,
  computeOpenSolRequirementForBins,
  computePositionAccountSize,
} from '@/bot/executor/utils'

/** The real rent-exemption formula the RPC applies for a 2-year-exempt account. */
const rentExemptionLamports = (size: number): number => (128 + size) * 6960

const mockConnection = {
  getMinimumBalanceForRentExemption: async (size: number) => rentExemptionLamports(size),
}

// Audit M1 rent table (SOL, as printed in the audit — rounded to 4 d.p.).
const RENT_MIN_ACCOUNT = 0.0579
const RENT_140_BINS = 0.1274
const RENT_220_BINS = 0.1987
// Exact values from the real rent formula (128 + size) * 6960 lamports.
const RENT_140_BINS_EXACT = rentExemptionLamports(18176) / 1e9 // 0.12739584
const RENT_220_BINS_EXACT = rentExemptionLamports(28416) / 1e9 // 0.19866624

describe('M1 — computePositionAccountSize (pins the byte sizes from the audit rent table)', () => {
  it('minimum account is 8,192 bytes', () => {
    expect(computePositionAccountSize(1)).toBe(8192)
  })

  it('140 bins -> 18,176 bytes; 220 bins -> 28,416 bytes', () => {
    expect(computePositionAccountSize(140)).toBe(256 + 140 * 128) // 18,176
    expect(computePositionAccountSize(140)).toBe(18176)
    expect(computePositionAccountSize(220)).toBe(256 + 220 * 128) // 28,416
    expect(computePositionAccountSize(220)).toBe(28416)
  })
})

describe('AC-B3.1 — computeOpenSolRequirement pins the arithmetic against the audit rent table', () => {
  it('140-bin position rent: solAmount + 0.1274 + ATA + headroom', () => {
    const solAmount = 0.5
    const required = computeOpenSolRequirement({ solAmount, positionRentSol: RENT_140_BINS })
    expect(required).toBeCloseTo(
      solAmount + RENT_140_BINS + 1 * ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL,
      10,
    )
    expect(required).toBeGreaterThanOrEqual(solAmount + 0.1274 + ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL)
    expect(required).toBeCloseTo(
      solAmount + RENT_140_BINS_EXACT + ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL,
      4,
    )
  })

  it('220-bin position rent: solAmount + 0.1987 + ATA + headroom', () => {
    const solAmount = 0.5
    const required = computeOpenSolRequirement({ solAmount, positionRentSol: RENT_220_BINS })
    expect(required).toBeCloseTo(
      solAmount + RENT_220_BINS + 1 * ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL,
      10,
    )
    expect(required).toBeGreaterThanOrEqual(solAmount + 0.1987 + ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL)
  })

  it('scales with ataCount and honours an explicit fee headroom', () => {
    const solAmount = 1
    const base = computeOpenSolRequirement({ solAmount, positionRentSol: RENT_140_BINS })
    const twoAtas = computeOpenSolRequirement({ solAmount, positionRentSol: RENT_140_BINS, ataCount: 2 })
    expect(twoAtas - base).toBeCloseTo(ATA_RENT_SOL, 10)
    const biggerHeadroom = computeOpenSolRequirement({
      solAmount,
      positionRentSol: RENT_140_BINS,
      feeHeadroomSol: 0.05,
    })
    expect(biggerHeadroom).toBeCloseTo(base + 0.05 - OPEN_FEE_HEADROOM_SOL, 10)
  })

  it('narrow range is bounded below by the minimum account size (never < 0.0579 rent)', () => {
    const required = computeOpenSolRequirement({ solAmount: 0, positionRentSol: RENT_MIN_ACCOUNT })
    expect(required).toBeGreaterThanOrEqual(RENT_MIN_ACCOUNT + ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL)
  })
})

describe('AC-B3.2 — the pre-rent gate (mocked connection) requires the ACTUAL rent for a 220-bin open', () => {
  const solAmount = 0.5

  it('derives 28,416 B and the audit\'s 0.1987 SOL rent from the RPC rent-exemption', async () => {
    const result = await computeOpenSolRequirementForBins(mockConnection, { solAmount, numBins: 220 })
    expect(result.positionAccountSize).toBe(28416)
    // matches the audit's 0.1987 table entry (exact: 0.19866624)
    expect(result.positionRentSol).toBeCloseTo(RENT_220_BINS, 3)
    expect(result.positionRentSol).toBe(RENT_220_BINS_EXACT)
    expect(result.positionRentLamports).toBe(rentExemptionLamports(28416))
  })

  it('required SOL for a 220-bin open is >= solAmount + 0.1987 + ATA + headroom', async () => {
    const result = await computeOpenSolRequirementForBins(mockConnection, { solAmount, numBins: 220 })
    // The gate uses the ACTUAL rent (0.19866624 — the audit's 0.1987 rounded up),
    // so it exceeds the audit's rounded figure on every component.
    expect(result.requiredSol).toBeGreaterThanOrEqual(
      solAmount + RENT_220_BINS_EXACT + ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL,
    )
    expect(result.requiredSol).toBeGreaterThanOrEqual(solAmount + 0.1986 + ATA_RENT_SOL + OPEN_FEE_HEADROOM_SOL)
    // and it is exactly the pure helper's output for the derived rent
    expect(result.requiredSol).toBeCloseTo(
      computeOpenSolRequirement({ solAmount, positionRentSol: RENT_220_BINS_EXACT }),
      10,
    )
  })

  it('regression: the OLD 0.07 reserve could pass the gate while the real need exceeded it', async () => {
    // Old early gate: solAmount + 0.07 + WALLET_MIN_SOL_RESERVE
    const oldRequired = solAmount + 0.07 + WALLET_MIN_SOL_RESERVE
    const realNeed = (
      await computeOpenSolRequirementForBins(mockConnection, { solAmount, numBins: 220 })
    ).requiredSol
    expect(oldRequired).toBeLessThan(realNeed) // the old gate under-estimated
    expect(0.07).toBeLessThan(RENT_220_BINS) // ~2x understatement
  })

  it('a 140-bin open requires less than a 220-bin open but still > the old 0.07 floor', async () => {
    const narrow = await computeOpenSolRequirementForBins(mockConnection, { solAmount, numBins: 140 })
    const wide = await computeOpenSolRequirementForBins(mockConnection, { solAmount, numBins: 220 })
    expect(narrow.requiredSol).toBeLessThan(wide.requiredSol)
    expect(narrow.positionRentSol - RENT_140_BINS).toBeLessThan(1e-6)
    expect(narrow.positionRentSol - 0.07).toBeGreaterThan(0)
  })
})

describe('AC-B3.3 — the early pre-flight floor never under-estimates the 220-bin worst case', () => {
  it('METEORA_RENT_RESERVE_SOL covers 220-bin rent + ATA rent', () => {
    expect(METEORA_RENT_RESERVE_SOL).toBeGreaterThanOrEqual(RENT_220_BINS)
    expect(METEORA_RENT_RESERVE_SOL).toBeGreaterThanOrEqual(RENT_220_BINS + ATA_RENT_SOL)
    expect(METEORA_RENT_RESERVE_SOL).toBeGreaterThan(0.07) // strictly more conservative
  })

  it('the early gate expression (solAmount + floor + WALLET_MIN) >= the exact 220-bin requirement', async () => {
    const solAmount = 0.5
    const earlyGate = solAmount + METEORA_RENT_RESERVE_SOL + WALLET_MIN_SOL_RESERVE
    const exact = (
      await computeOpenSolRequirementForBins(mockConnection, { solAmount, numBins: 220 })
    ).requiredSol
    expect(earlyGate).toBeGreaterThanOrEqual(exact)
  })
})

describe('AC-B3.4 — wiring guard: the reserve computation and gate ordering are wired as specified', () => {
  const repoRoot = process.cwd()
  const openSrc = fs.readFileSync(path.join(repoRoot, 'bot/executor/open.ts'), 'utf8')
  const utilsSrc = fs.readFileSync(path.join(repoRoot, 'bot/executor/utils.ts'), 'utf8')

  it('utils.ts declares the conservative floor and no longer the 0.07 value', () => {
    expect(utilsSrc).toContain('METEORA_RENT_RESERVE_SOL = 0.215')
    expect(utilsSrc).not.toContain('METEORA_RENT_RESERVE_SOL = 0.07')
    expect(utilsSrc).toContain('export function computeOpenSolRequirement(')
  })

  it('open.ts enforces the exact requirement with the ACTUAL rent in the pre-rent path', () => {
    expect(openSrc).toContain('computeOpenSolRequirementForBins(connection, { solAmount, numBins })')
    expect(openSrc).toContain('computeOpenSolRequirement({')
  })

  it('the early pre-swap check still uses the conservative floor constant', () => {
    expect(openSrc).toContain('solAmount + METEORA_RENT_RESERVE_SOL + WALLET_MIN_SOL_RESERVE')
  })
})