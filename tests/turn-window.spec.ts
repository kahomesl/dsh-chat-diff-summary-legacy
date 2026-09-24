/**
 * Reading where a Session's log stands.
 *
 * The browser half reads two facts from the durable log: the newest turn
 * boundary and whether that turn is still open, and the newest durable sequence,
 * which is what makes the bar follow a turn while it runs. Boundaries come from
 * the real `turn/start` / `turn/end` events — never from a timer, an input event,
 * or the appearance of assistant text.
 */
import { describe, expect, test } from 'vitest'
import { logPosition } from '../src/client/turn-window.ts'
import type { EventWindowLike } from '../src/client/contract.ts'

/** One window over the given entries. */
function windowOf(...entries: EventWindowLike['entries']): EventWindowLike {
  return { entries }
}

/** A durable entry. */
function event(type: string, seq: number, data?: unknown): EventWindowLike['entries'][number] {
  return { type: 'event', event: { type, seq, ...(data === undefined ? {} : { data }) } }
}

/** A client-only live frame. */
function transient(type: string, seq: number, data?: unknown): EventWindowLike['entries'][number] {
  return { type: 'transient', event: { type, seq, ...(data === undefined ? {} : { data }) } }
}

describe('logPosition', () => {
  test('reports nothing for an absent or empty window', () => {
    expect(logPosition(undefined)).toEqual({ boundary: undefined, seq: -1 })
    expect(logPosition(windowOf())).toEqual({ boundary: undefined, seq: -1 })
  })

  test('reports an open turn while it is still running', () => {
    expect(logPosition(windowOf(event('turn/start', 0, { turn: 1 }), event('user/message', 1)))).toEqual({
      boundary: { turn: 1, open: true },
      seq: 1,
    })
  })

  test('reports a closed turn once it ends', () => {
    expect(logPosition(windowOf(event('turn/start', 0, { turn: 1 }), event('turn/end', 4, { turn: 1 })))).toEqual({
      boundary: { turn: 1, open: false },
      seq: 4,
    })
  })

  test('follows the newest boundary, not the last entry in reading order', () => {
    const window = windowOf(
      event('turn/end', 2, { turn: 1 }),
      event('turn/start', 9, { turn: 2 }),
      event('assistant/message', 12, { turn: 2 }),
    )
    expect(logPosition(window)).toEqual({ boundary: { turn: 2, open: true }, seq: 12 })
  })

  test('ignores a client-only live frame, both as a boundary and as activity', () => {
    // Live chunks arrive per streamed token; counting them as activity would
    // make the bar re-read on every token of a reply.
    const window = windowOf(event('turn/start', 2, { turn: 1 }), transient('assistant/live-chunk', 99, { turn: 1 }), transient('turn/end', 100, { turn: 9 }))
    expect(logPosition(window)).toEqual({ boundary: { turn: 1, open: true }, seq: 2 })
  })

  test('ignores a boundary whose turn is malformed', () => {
    for (const data of [undefined, {}, { turn: 0 }, { turn: -1 }, { turn: 1.5 }, { turn: '2' }, null]) {
      expect(logPosition(windowOf(event('turn/end', 3, data))).boundary).toBeUndefined()
    }
  })

  test('ignores a boundary whose sequence is not a usable number', () => {
    expect(logPosition(windowOf({ type: 'event', event: { type: 'turn/end', seq: Number.NaN, data: { turn: 1 } } })).boundary).toBeUndefined()
  })

  test('accepts an entry that carries no transport discriminator', () => {
    expect(logPosition(windowOf({ event: { type: 'turn/start', seq: 5, data: { turn: 3 } } }))).toEqual({
      boundary: { turn: 3, open: true },
      seq: 5,
    })
  })

  test('advances the sequence on every durable event, so a running turn keeps invalidating', () => {
    const started = windowOf(event('turn/start', 0, { turn: 1 }))
    const called = windowOf(...started.entries, event('tool/call', 3, { turn: 1 }))
    const settled = windowOf(...called.entries, event('tool/result', 4, { turn: 1 }))
    expect(logPosition(started).seq).toBe(0)
    expect(logPosition(called).seq).toBe(3)
    expect(logPosition(settled).seq).toBe(4)
    // The boundary is unchanged across all three; only the sequence moves.
    expect(logPosition(settled).boundary).toEqual({ turn: 1, open: true })
  })
})
