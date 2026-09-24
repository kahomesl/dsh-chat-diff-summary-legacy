/**
 * Reading where a Session's log stands.
 *
 * The browser half needs two things from the durable log: which turn is the
 * newest one and whether it is still open, and whether anything new has arrived
 * since the last read. Turn boundaries come from the real `turn/start` /
 * `turn/end` events — never from a timer, an input event, or the appearance of
 * assistant text — and the newest durable sequence is what lets the bar keep up
 * with a turn while it runs rather than only once it closes.
 */
import type { EventWindowLike } from './contract.ts'

/** The newest turn boundary in a window. */
export interface TurnBoundary {
  /** The turn the boundary names. */
  readonly turn: number
  /** True for `turn/start` — the turn is running and may still change files. */
  readonly open: boolean
}

/** Where one Session's log stands. */
export interface LogPosition {
  /** The newest turn boundary, or undefined before this Session's first turn. */
  readonly boundary: TurnBoundary | undefined
  /**
   * The highest durable sequence in the window, or -1 when it holds none.
   *
   * Client-only live frames are excluded on purpose: they arrive per streamed
   * chunk, and treating each as new activity would make the bar re-read on every
   * token of a reply.
   */
  readonly seq: number
}

/** The turn a boundary payload names, or undefined when it is malformed. */
function announcedTurn(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const turn = (data as { turn?: unknown }).turn
  return Number.isSafeInteger(turn) && (turn as number) >= 1 ? (turn as number) : undefined
}

/**
 * Find the newest turn boundary and the newest durable sequence in one window.
 *
 * The window is contiguous but may be a tail slice, so both answers are the
 * highest sequences carrying the right shape rather than the last entry in
 * reading order.
 * @param window - the Session binding's event window, or undefined before a binding exists.
 * @returns the position; a window with no turn boundary still reports its newest sequence.
 */
export function logPosition(window: EventWindowLike | undefined): LogPosition {
  if (window === undefined) return { boundary: undefined, seq: -1 }
  let boundary: TurnBoundary | undefined
  let boundarySeq = -1
  let seq = -1
  for (const entry of window.entries) {
    // A transient entry is a client-only live frame, not durable history.
    if (entry.type === 'transient') continue
    const event = entry.event
    if (event === undefined) continue
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) continue
    if (event.seq > seq) seq = event.seq
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    if (event.seq <= boundarySeq) continue
    const turn = announcedTurn(event.data)
    if (turn === undefined) continue
    boundary = { turn, open: event.type === 'turn/start' }
    boundarySeq = event.seq
  }
  return { boundary, seq }
}
