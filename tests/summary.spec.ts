/**
 * The contract both halves share: the wire validators, the URL both sides agree
 * on, and the one rule about when the bar has anything to say.
 */
import { describe, expect, test } from 'vitest'
import {
  ENTRY_ID,
  formatCount,
  hasChanges,
  isChangeSummary,
  isChangedFile,
  MAX_FILES,
  MAX_RETAINED_TURNS,
  PLUGIN_NAME,
  SUMMARY_PATH,
  summaryUrl,
  type ChangeSummary,
} from '../src/summary.ts'

/** A minimal well-formed summary. */
function summary(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return { turn: 1, files: [], total: 0, added: 0, deleted: 0, ...overrides }
}

describe('identity', () => {
  test('names the plugin, the dock entry and the route distinctly', () => {
    expect(PLUGIN_NAME).toBe('chat-diff-summary-legacy')
    expect(ENTRY_ID).toBe('chat-diff-summary-legacy')
    expect(SUMMARY_PATH).toBe('/api/chat-diff-summary-legacy.summary')
    // A third-party route, never one of the shipped /api paths.
    expect(SUMMARY_PATH.startsWith('/api/')).toBe(true)
    expect(MAX_FILES).toBeGreaterThan(0)
    expect(MAX_RETAINED_TURNS).toBeGreaterThan(1)
  })
})

describe('formatCount', () => {
  test('groups thousands with a language-independent separator', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(20)).toBe('20')
    expect(formatCount(542)).toBe('542')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(1234567)).toBe('1,234,567')
  })
})

describe('isChangedFile', () => {
  test('accepts a counted file', () => {
    expect(isChangedFile({ path: 'a.ts', display: 'a.ts', added: 3, deleted: 1 })).toBe(true)
  })

  test('accepts a binary file only when it says so', () => {
    expect(isChangedFile({ path: 'a.png', display: 'a.png', added: 0, deleted: 0, binary: true })).toBe(true)
    expect(isChangedFile({ path: 'a.png', display: 'a.png', added: 0, deleted: 0, binary: false })).toBe(false)
  })

  test('rejects a record with no path or with invented counts', () => {
    for (const value of [
      null,
      undefined,
      [],
      'a.ts',
      { display: 'a.ts', added: 1, deleted: 0 },
      { path: '', display: 'a.ts', added: 1, deleted: 0 },
      { path: 'a.ts', display: '', added: 1, deleted: 0 },
      { path: 'a.ts', display: 'a.ts', added: -1, deleted: 0 },
      { path: 'a.ts', display: 'a.ts', added: 1.5, deleted: 0 },
      { path: 'a.ts', display: 'a.ts', added: 1, deleted: '0' },
    ]) {
      expect(isChangedFile(value)).toBe(false)
    }
  })
})

describe('isChangeSummary', () => {
  test('accepts the shape the host route serves', () => {
    expect(isChangeSummary(summary({ files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 2 }], total: 1, added: 1, deleted: 2 }))).toBe(true)
  })

  test('rejects a payload missing a total or carrying a bad one', () => {
    for (const value of [
      null,
      [],
      {},
      summary({ turn: 0 }),
      summary({ total: -1 }),
      summary({ added: -1 }),
      summary({ deleted: -1 }),
      summary({ files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }, { nope: true } as never] }),
      { ...summary(), files: 'none' },
    ]) {
      expect(isChangeSummary(value)).toBe(false)
    }
  })
})

describe('hasChanges', () => {
  test('is false for nothing and for a clean turn, true once files moved', () => {
    expect(hasChanges(undefined)).toBe(false)
    expect(hasChanges(summary())).toBe(false)
    expect(hasChanges(summary({ total: 1 }))).toBe(true)
  })
})

describe('summaryUrl', () => {
  test('is origin-absolute and carries the Session', () => {
    expect(summaryUrl('abc')).toBe('/api/chat-diff-summary-legacy.summary?sessionId=abc')
  })

  test('adds the turn when one is named', () => {
    expect(summaryUrl('abc', 7)).toBe('/api/chat-diff-summary-legacy.summary?sessionId=abc&turn=7')
  })

  test('escapes a Session id instead of letting it reshape the query', () => {
    expect(summaryUrl('a&turn=9')).toBe('/api/chat-diff-summary-legacy.summary?sessionId=a%26turn%3D9')
  })
})
