/**
 * The one read the bar performs: the newest turn's summary, fetched from this
 * plugin's own authenticated host route.
 *
 * The window subscription is used as a *signal*, not as data. It moves on every
 * durable event, so the bar keeps up with a turn while it runs: the host
 * re-measures an open turn after each settled tool call, and each measurement
 * reaches this source as a fresh read of the same turn. The previously drawn
 * numbers stay up while a read is in flight — a running turn never flickers the
 * bar through an empty state — and a turn that changed nothing replaces them
 * with nothing.
 */
import { isChangeSummary, summaryUrl, type ChangeSummary } from '../summary.ts'
import type { ObservableLike, SessionBindingLike } from './contract.ts'
import { logPosition, type LogPosition } from './turn-window.ts'

/** The request surface, narrowed so specs inject a stub instead of a real transport. */
export type SummaryReader = (url: string, signal: AbortSignal) => Promise<Response>

/** What the bar draws. */
export interface ChangeSnapshot {
  /** The summary standing for the newest completed turn, or undefined when there is none to draw. */
  readonly summary: ChangeSummary | undefined
}

/** The absent view a source without a binding still serves. */
const NO_SUMMARY: ChangeSnapshot = { summary: undefined }

/**
 * Whether two summaries say the same thing.
 *
 * Each read decodes a fresh JSON object, so identity alone would report a change
 * on every re-read of an unchanged turn. Comparing by value keeps the snapshot
 * identity — and with it the component's render and its expanded state — stable
 * while the numbers stand still.
 * @param left - the standing summary, or undefined.
 * @param right - the freshly read summary, or undefined.
 * @returns whether the bar has nothing new to draw.
 */
function sameSummary(left: ChangeSummary | undefined, right: ChangeSummary | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  if (left.turn !== right.turn || left.total !== right.total || left.added !== right.added || left.deleted !== right.deleted) return false
  if (left.files.length !== right.files.length) return false
  return left.files.every((file, index) => {
    const other = right.files[index]
    return other !== undefined
      && file.path === other.path
      && file.display === other.display
      && file.added === other.added
      && file.deleted === other.deleted
      && file.binary === other.binary
  })
}

/**
 * The read key for one log position.
 *
 * The newest durable sequence is part of the key, so any new activity — the
 * `tool/result` the host measures after, a `turn/end`, another `turn/start` —
 * invalidates the standing read. The turn's own number and whether it is open
 * are in it too, so a read can never be answered by a different turn's numbers.
 * @param position - the Session's log position.
 * @returns an opaque key.
 */
function readKey(position: LogPosition): string {
  const boundary = position.boundary
  if (boundary === undefined) return 'latest'
  return `${boundary.open ? 'open' : 'closed'}:${String(boundary.turn)}:${String(position.seq)}`
}

/**
 * The session-bound observable one mounted bar reads through.
 *
 * Deliberately not a class with methods the caller must bind: the framework
 * hands this object straight to `useSyncExternalStore`, which requires
 * `getSnapshot` and `subscribe` to keep their identity and their `this`.
 */
export interface DiffSummarySource extends ObservableLike<ChangeSnapshot> {
  /** Re-read the newest summary; used when the connection is replaced. */
  refresh(): void
}

/**
 * Mint the source for one Session.
 *
 * Every read is aimed at the Session this source was minted for, so switching
 * Sessions swaps the source rather than the data underneath it.
 * @param sessionId - the Session the dock entry is mounted in.
 * @param binding - that Session's client binding, or undefined when it has none.
 * @param read - the request implementation; defaults to the page's `fetch`.
 * @returns the observable source the dock entry injects as `useSummary`.
 */
export function createDiffSummarySource(
  sessionId: string,
  binding: SessionBindingLike | undefined,
  read: SummaryReader = (url, signal) => fetch(url, { signal }),
): DiffSummarySource {
  let snapshot: ChangeSnapshot = NO_SUMMARY
  let signal: string | undefined
  let generation = new AbortController()
  let reading = false
  let dirty = false
  const listeners = new Set<() => void>()

  /**
   * Publish a settled state, keeping snapshot identity stable while nothing
   * changed — identity is what `useSyncExternalStore` and the component's
   * expanded state both key on.
   */
  const publish = (next: ChangeSummary | undefined): void => {
    if (sameSummary(snapshot.summary, next)) return
    snapshot = { summary: next }
    for (const listener of [...listeners]) listener()
  }

  /** Run one read and publish its outcome, unless a newer signal replaced it. */
  const load = async (key: string, turn: number | undefined): Promise<void> => {
    const scope = generation
    let next: ChangeSummary | undefined
    try {
      const response = await read(summaryUrl(sessionId, turn), scope.signal)
      if (scope.signal.aborted) return
      // 204 is the Host saying this turn has nothing to draw. Any other refusal
      // is a transport-level failure, which must not hide a summary that is
      // still true.
      if (response.status === 204) {
        publish(undefined)
        return
      }
      if (!response.ok) return
      const value: unknown = await response.json()
      next = isChangeSummary(value) ? value : undefined
    } catch {
      // A failed transport leaves the previous summary standing: a reconnect
      // blip must not blank a bar that is still true.
      return
    }
    if (scope.signal.aborted || signal !== key) return
    publish(next)
  }

  /**
   * Read whenever the Session's log has moved.
   *
   * A turn produces many durable events, so this coalesces instead of queueing:
   * one read is in flight at a time, and activity during a read marks the source
   * dirty, which re-reads once as soon as that read settles. The guards inside
   * {@link load} — a superseded key, or a generation a refresh abandoned — are
   * what keep a stale answer from landing.
   */
  const pump = async (): Promise<void> => {
    if (reading) {
      dirty = true
      return
    }
    reading = true
    try {
      for (;;) {
        dirty = false
        const position = logPosition(binding?.eventSource.getSnapshot())
        const key = readKey(position)
        if (key !== signal) {
          signal = key
          await load(key, position.boundary?.turn)
        }
        if (!dirty) break
      }
    } finally {
      reading = false
    }
  }

  const observe = (): void => {
    void pump().catch(() => {})
  }

  binding?.eventSource.subscribe(observe)
  observe()

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: () => {
      generation.abort()
      generation = new AbortController()
      signal = undefined
      observe()
    },
  }
}
