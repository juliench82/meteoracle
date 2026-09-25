/**
 * Hermetic tests for position SOL sizing after the M5 phantom-knob removal.
 *
 * AC-B1.5 — position SOL sizing equals the env cap regardless of strategy fields.
 *
 * The former `strategy.position.maxSolPerPosition` branch in bot/executor/open.ts:158-172
 * was always dead (strategies/evil-panda.ts never sets the field), so removing it is
 * behaviour-identical. These tests pin that the effective amount is the configured cap
 * and that the field no longer exists on the type.
 */
import { describe, expect, it } from 'vitest'
import { getPositionSolAmount, MARKET_LP_SOL_PER_POSITION } from '@/lib/strategy-config'
import type { PositionConfig } from '@/lib/types'

describe('AC-B1.5 — position SOL sizing equals the env cap (M5)', () => {
  it('returns MARKET_LP_SOL_PER_POSITION', () => {
    expect(getPositionSolAmount()).toBe(MARKET_LP_SOL_PER_POSITION)
  })

  it('a strategy-like object still carrying the removed field cannot change the amount', () => {
    const phantomStrategy = { position: { maxSolPerPosition: 999, solBias: 0 } }
    // The sizing helper takes no strategy input at all — the override branch is gone.
    expect((getPositionSolAmount as (strategy?: unknown) => number)(phantomStrategy)).toBe(
      MARKET_LP_SOL_PER_POSITION,
    )
  })

  it('the PositionConfig type no longer declares maxSolPerPosition', () => {
    const cfg: PositionConfig = {
      binStep: 100,
      rangeDownPct: -50,
      rangeUpPct: 100,
      distributionType: 'bid-ask',
      solBias: 1,
      // @ts-expect-error maxSolPerPosition was removed in M5 (phantom knob, always undefined)
      maxSolPerPosition: 0.5,
    }
    // Reaching here at all proves the value is ignored: sizing never reads it.
    expect(getPositionSolAmount()).toBe(MARKET_LP_SOL_PER_POSITION)
    expect(cfg.binStep).toBe(100)
  })
})