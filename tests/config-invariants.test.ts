/**
 * Hermetic tests for the fee/TVL exit-vs-entry config invariant
 * (lib/config-invariants.ts) and the behavior of validateStartup() around it.
 */
import { describe, expect, it } from 'vitest'
import { checkFeeTvlExitVsEntry } from '@/lib/config-invariants'
import { validateStartup } from '@/lib/startup-validation'

describe('checkFeeTvlExitVsEntry — AC9', () => {
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

describe('validateStartup behavior unchanged (non-fatal, still returns false without config)', () => {
  it('resolves to false without throwing in a hermetic (no-env) environment — the same non-fatal contract as before', async () => {
    // No RPC_URL / HELIUS / wallet env: validateStartup hits its existing
    // non-fatal paths (getConnection throws -> caught -> ok=false) and must
    // NOT throw out of the function. Behavior unchanged by the extraction.
    await expect(validateStartup('test')).resolves.toBe(false)
  })
})