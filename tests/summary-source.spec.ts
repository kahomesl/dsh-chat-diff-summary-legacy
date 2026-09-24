/**
 * The summary source: one read per completed turn, keyed by that turn's own
 * coordinates, with the previous turn's numbers standing until the new ones
 * arrive and a replaced connection dropping everything it cached.
 */
import { describe, expect, test, vi } from 'vitest'
import { createDiffSummarySource } from '../src/client/summary-source.ts'
import type { SummaryReader } from '../src/client/summary-source.ts'
import type { EventWindowLike, SessionBindingLike } from '../src/client/contract.ts'
import { SUMMARY_PATH, type ChangeSummary } from '../src/summary.ts'

/** A summary as the host route serves it. */
function summary(turn: number, total: number, added = 4, deleted = 2): ChangeSummary {
  return { turn, total, added, deleted, files: [] }
}

/** A window the spec can grow, with subscribers it can wake. */
class FakeBinding implements SessionBindingLike {
  readonly sessionId = 'session-a'
  entries: EventWindowLike['entries'] = []
  readonly listeners = new Set<() => void>()
  readonly eventSource = {
    getSnapshot: (): EventWindowLike => ({ entries: this.entries }),
    subscribe: (listener: () => void): (() => void) => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    },
  }

  /** Append one durable event and wake the source, as the real feed would. */
  append(type: string, seq: number, data: unknown): void {
    this.entries = [...this.entries, { type: 'event', event: { type, seq, data } }]
    for (const listener of [...this.listeners]) listener()
  }

  /** Append one `turn/end`. */
  endTurn(turn: number, seq: number): void {
    this.append('turn/end', seq, { turn })
  }

  /** Append one `turn/start`. */
  startTurn(turn: number, seq: number): void {
    this.append('turn/start', seq, { turn })
  }
}

/** A reader that answers from a scripted table and records every URL it saw. */
function scriptedReader(table: Map<string, Response | Error>): { read: SummaryReader; urls: string[] } {
  const urls: string[] = []
  return {
    urls,
    read: (url) => {
      urls.push(url)
      const answer = table.get(url)
      if (answer === undefined) return Promise.resolve(new Response(null, { status: 204 }))
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer.clone())
    },
  }
}

/** A 200 response carrying one summary. */
function ok(body: ChangeSummary): Response {
  return Response.json(body)
}

/**
 * Let the source's reads settle. Real macrotasks, because `Response.json()`
 * drains a body stream rather than resolving on the microtask queue.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a Session with no completed turn', () => {
  test('asks for the newest summary once and draws nothing when there is none', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>()
    const { read, urls } = scriptedReader(table)
    const source = createDiffSummarySource('session-a', binding, read)
    await settle()
    expect(urls).toEqual([`${SUMMARY_PATH}?sessionId=session-a`])
    expect(source.getSnapshot()).toEqual({ summary: undefined })
  })

  test('draws the standing summary once the host has one', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))]])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    expect(source.getSnapshot().summary?.total).toBe(3)
  })
})

describe('a completed turn', () => {
  test('reads that turn by number rather than asking for the latest', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))],
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=2', ok(summary(2, 0))],
    ])
    const { read, urls } = scriptedReader(table)
    const source = createDiffSummarySource('session-a', binding, read)
    await settle()
    binding.endTurn(2, 7)
    await settle()
    expect(urls).toEqual([
      '/api/chat-diff-summary-legacy.summary?sessionId=session-a',
      '/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=2',
    ])
    expect(source.getSnapshot().summary?.turn).toBe(2)
  })

  test('hides the bar when the new turn changed nothing', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))],
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=2', ok(summary(2, 0))],
    ])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    expect(source.getSnapshot().summary?.total).toBe(3)
    binding.endTurn(2, 7)
    await settle()
    expect(source.getSnapshot().summary?.total).toBe(0)
  })

  test('keeps the previous numbers up while the new turn is still being read', async () => {
    const binding = new FakeBinding()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read: SummaryReader = (url) => {
      if (url.includes('turn=2')) return gate.then(() => ok(summary(2, 9)))
      return Promise.resolve(ok(summary(1, 3)))
    }
    const source = createDiffSummarySource('session-a', binding, read)
    await settle()
    binding.endTurn(2, 7)
    await settle()
    // Turn 2 is in flight; turn 1's truth is still on screen.
    expect(source.getSnapshot().summary?.turn).toBe(1)
    release?.()
    await settle()
    expect(source.getSnapshot().summary?.turn).toBe(2)
  })

  test('re-reads once per turn end, not once per event', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))],
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=2', ok(summary(2, 5))],
    ])
    const { read, urls } = scriptedReader(table)
    const source = createDiffSummarySource('session-a', binding, read)
    await settle()
    binding.endTurn(2, 7)
    await settle()
    // The same boundary seen again — a paging or re-render — is not a new read.
    for (const listener of [...binding.listeners]) listener()
    await settle()
    expect(urls).toHaveLength(2)
    expect(source.getSnapshot().summary?.turn).toBe(2)
  })

  test('keeps reading while a turn is open, so the bar follows it live', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>()
    const { read, urls } = scriptedReader(table)
    const seen: (string | undefined)[] = []
    const source = createDiffSummarySource('session-a', binding, (url, signal) => {
      seen.push(url.includes('turn=') ? url.slice(url.indexOf('turn=')) : 'latest')
      return read(url, signal)
    })
    await settle()
    expect(source.getSnapshot().summary).toBeUndefined()

    // The turn opens, then each settled tool call moves the log. Every move must
    // reach the host again, and every one of them asks about the OPEN turn.
    binding.startTurn(1, 5)
    table.set('/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=1', ok(summary(1, 2)))
    await settle()
    binding.append('tool/result', 9, { turn: 1 })
    await settle()
    binding.append('tool/result', 14, { turn: 1 })
    await settle()
    expect(seen.filter((entry) => entry === 'turn=1').length).toBeGreaterThanOrEqual(2)
    expect(source.getSnapshot().summary?.total).toBe(2)
    expect(urls.every((url) => !url.includes('turn=2'))).toBe(true)
  })

  test('keeps snapshot identity when a re-read reports the same numbers', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))]])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    const listener = vi.fn()
    source.subscribe(listener)
    await settle()
    const first = source.getSnapshot()
    expect(first.summary?.total).toBe(3)
    listener.mockClear()
    // More activity, same numbers: the snapshot object, and so the render and the
    // expanded list, must not churn.
    binding.append('assistant/message', 4, { turn: 1 })
    await settle()
    expect(source.getSnapshot()).toBe(first)
    expect(listener).not.toHaveBeenCalled()
  })

  test('hides the bar when the host answers 204 for the turn', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))],
    ])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    binding.endTurn(2, 7)
    await settle()
    expect(source.getSnapshot().summary).toBeUndefined()
  })

  test('leaves the previous numbers standing when the host refuses the read', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))],
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=2', new Response(null, { status: 500 })],
    ])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    binding.endTurn(2, 7)
    await settle()
    expect(source.getSnapshot().summary?.turn).toBe(1)
  })

  test('leaves the previous numbers standing through a transport failure', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))],
      ['/api/chat-diff-summary-legacy.summary?sessionId=session-a&turn=2', new Error('offline')],
    ])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    binding.endTurn(2, 7)
    await settle()
    expect(source.getSnapshot().summary?.turn).toBe(1)
  })

  test('ignores a payload that is not a summary', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([['/api/chat-diff-summary-legacy.summary?sessionId=session-a', Response.json({ nope: true })]])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    expect(source.getSnapshot()).toEqual({ summary: undefined })
  })
})

describe('the observable contract', () => {
  test('keeps snapshot identity while nothing changes', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))]])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    await settle()
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
    binding.endTurn(2, 7)
    await settle()
    expect(source.getSnapshot()).not.toBe(first)
  })

  test('notifies subscribers exactly once per settled change', async () => {
    const binding = new FakeBinding()
    const table = new Map<string, Response | Error>([['/api/chat-diff-summary-legacy.summary?sessionId=session-a', ok(summary(1, 3))]])
    const source = createDiffSummarySource('session-a', binding, scriptedReader(table).read)
    const listener = vi.fn()
    const unsubscribe = source.subscribe(listener)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    binding.endTurn(2, 7)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('a replaced connection', () => {
  test('forgets the cache and reads again', async () => {
    const binding = new FakeBinding()
    let answer = summary(1, 3)
    const urls: string[] = []
    const read: SummaryReader = (url) => {
      urls.push(url)
      return Promise.resolve(ok(answer))
    }
    const source = createDiffSummarySource('session-a', binding, read)
    await settle()
    expect(source.getSnapshot().summary?.total).toBe(3)
    answer = summary(1, 7)
    source.refresh()
    await settle()
    expect(urls).toHaveLength(2)
    expect(source.getSnapshot().summary?.total).toBe(7)
  })

  test('drops an in-flight read when the connection is replaced', async () => {
    const binding = new FakeBinding()
    let first = true
    // Faithful to `fetch`: aborting the generation rejects the pending request,
    // which is what lets the replacement read start instead of queueing behind it.
    const read: SummaryReader = (_url, signal) => {
      if (!first) return Promise.resolve(ok(summary(1, 42)))
      first = false
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('aborted'))
        }, { once: true })
      })
    }
    const source = createDiffSummarySource('session-a', binding, read)
    await settle()
    source.refresh()
    await settle()
    expect(source.getSnapshot().summary?.total).toBe(42)
  })
})

describe('a Session without a binding', () => {
  test('still asks once and never subscribes to anything', async () => {
    const table = new Map<string, Response | Error>([['/api/chat-diff-summary-legacy.summary?sessionId=orphan', ok(summary(1, 2))]])
    const { read, urls } = scriptedReader(table)
    const source = createDiffSummarySource('orphan', undefined, read)
    await settle()
    expect(urls).toHaveLength(1)
    expect(source.getSnapshot().summary?.total).toBe(2)
  })
})
