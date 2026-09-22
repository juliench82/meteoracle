/**
 * Hermetic tests for the Telegram auth gate (lib/telegram-auth.ts).
 *
 * Contract under test (audit §8/§9): sender-ID allowlist ONLY — a command is
 * allowed iff the SENDER's user id is allowed. The chat id is NEVER a fallback
 * (no "any member of an allowed group chat can run privileged commands" bug).
 */
import { describe, expect, it } from 'vitest'
import {
  isTelegramCommandAllowed,
  isTelegramUserAllowed,
  parseTelegramAllowedUsers,
} from '@/lib/telegram-auth'

describe('parseTelegramAllowedUsers', () => {
  it('splits on commas and whitespace, trims, drops empties', () => {
    const set = parseTelegramAllowedUsers('123, 456  789,\n1000')
    expect([...set].sort()).toEqual(['1000', '123', '456', '789'])
  })

  it('handles empty string and undefined as an empty allowlist', () => {
    expect(parseTelegramAllowedUsers('')).toEqual(new Set<string>())
    expect(parseTelegramAllowedUsers(undefined)).toEqual(new Set<string>())
  })

  it('returns empty set for separator-only input', () => {
    expect(parseTelegramAllowedUsers('  ,  ,  ')).toEqual(new Set<string>())
  })
})

describe('isTelegramUserAllowed', () => {
  const allowed = new Set(['123', '456'])

  it('accepts numeric ids via string coercion', () => {
    expect(isTelegramUserAllowed(123, allowed)).toBe(true)
    expect(isTelegramUserAllowed('123', allowed)).toBe(true)
  })

  it('rejects unknown ids', () => {
    expect(isTelegramUserAllowed(999, allowed)).toBe(false)
    expect(isTelegramUserAllowed('888', allowed)).toBe(false)
  })

  it('rejects null/undefined', () => {
    expect(isTelegramUserAllowed(null, allowed)).toBe(false)
    expect(isTelegramUserAllowed(undefined, allowed)).toBe(false)
  })
})

describe('isTelegramCommandAllowed — sender allowlist only, chat id never consulted', () => {
  it('AC5: disallowed sender + any chat id => false', () => {
    expect(isTelegramCommandAllowed(999, 12345, new Set(['123', '456']))).toBe(false)
  })

  it('chat id is never a fallback: disallowed sender + chat id that IS allowed => false', () => {
    // The chat id (123) is in the allowlist, but the SENDER (999) is not.
    expect(isTelegramCommandAllowed(999, 123, new Set(['123', '456']))).toBe(false)
  })

  it('allowed sender passes regardless of the chat id argument', () => {
    expect(isTelegramCommandAllowed(123, 99999, new Set(['123', '456']))).toBe(true)
  })

  it('null sender never passes even with a known chat id', () => {
    expect(isTelegramCommandAllowed(null, 123, new Set(['123']))).toBe(false)
  })
})