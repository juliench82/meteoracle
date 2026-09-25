/**
 * Hermetic tests for the PM2 control-plane target selection (lib/pm2-targets.ts).
 *
 * Contract under test (audit §M3): the Telegram control plane is the ONLY recovery
 * channel that can issue `/start` without SSH. Neither `/stop` nor `/reload`
 * (restart) may ever target `meteoracle-telegram`, otherwise the command destroys
 * the very process that could bring the bot back.
 */
import { describe, expect, it } from 'vitest'
import { buildPm2Argv, buildPm2Targets } from '@/lib/pm2-targets'

describe('buildPm2Targets', () => {
  it('AC-B7.1: /stop targets contain meteoracle-worker only (never meteoracle-telegram)', () => {
    const targets = buildPm2Targets('stop')
    expect(targets).toContain('meteoracle-worker')
    expect(targets).not.toContain('meteoracle-telegram')
    expect(targets).toEqual(['meteoracle-worker'])
  })

  it('AC-B7.2: /reload targets exclude meteoracle-telegram (control plane survives restart)', () => {
    const targets = buildPm2Targets('restart')
    expect(targets).not.toContain('meteoracle-telegram')
    expect(targets).toEqual(['meteoracle-worker'])
  })
})

describe('buildPm2Argv', () => {
  it('AC-B7.1: /stop argv is [stop, meteoracle-worker] — telegram excluded', () => {
    expect(buildPm2Argv('stop')).toEqual(['stop', 'meteoracle-worker'])
    expect(buildPm2Argv('stop').join(' ')).toBe('stop meteoracle-worker')
  })

  it('AC-B7.2: /reload argv is [restart, meteoracle-worker] — telegram excluded', () => {
    expect(buildPm2Argv('restart')).toEqual(['restart', 'meteoracle-worker'])
    expect(buildPm2Argv('restart').join(' ')).toBe('restart meteoracle-worker')
  })
})