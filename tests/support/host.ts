/**
 * A host context shaped like the real Cordis one, recording what the plugin
 * registered so a spec can drive it and dispose it the way the Loader would.
 */
import type { FetchRoute, HostContext, ListenerOptions, SessionEventLike, SessionLike, ToolExecutionLike } from '../../src/host.ts'

/** One captured listener, invocable by the spec. */
type Listener = (...args: never[]) => unknown

/** The captured surface of one plugin registration. */
export class HostHarness {
  readonly routes = new Map<string, FetchRoute>()
  readonly warnings: string[] = []
  /** The order in which plugin work reached the tool waterfall. */
  readonly gateOrder: string[] = []
  private readonly listeners = new Map<string, Listener[]>()
  private readonly disposers: (() => void)[] = []
  private disposed = false

  /** The context handed to `apply`. */
  readonly ctx = {
    connection: {
      fetch: {
        register: (route: FetchRoute): (() => void) => {
          if (this.routes.has(route.path)) throw new Error(`route already registered: ${route.path}`)
          this.routes.set(route.path, route)
          const dispose = (): void => {
            this.routes.delete(route.path)
          }
          this.disposers.push(dispose)
          return dispose
        },
      },
    },
    logger: {
      warn: (message: string): void => {
        this.warnings.push(message)
      },
      info: (): void => {},
    },
    on: (name: string, listener: Listener, _options?: ListenerOptions): (() => void) => {
      const list = this.listeners.get(name) ?? []
      list.push(listener)
      this.listeners.set(name, list)
      const dispose = (): void => {
        const current = this.listeners.get(name)
        if (current === undefined) return
        this.listeners.set(name, current.filter((entry) => entry !== listener))
      }
      this.disposers.push(dispose)
      return dispose
    },
    effect: (callback: () => (() => void) | void): void => {
      const dispose = callback()
      if (typeof dispose === 'function') this.disposers.push(dispose)
    },
  } as unknown as HostContext

  /** The raw harness view, for assertions that do not need the typed context. */
  get registeredRoutes(): string[] {
    return [...this.routes.keys()]
  }

  /** Append one Session event, exactly as the append feed publishes it. */
  emitSessionEvent(session: SessionLike, event: SessionEventLike): void {
    for (const listener of [...(this.listeners.get('session/event') ?? [])]) {
      ;(listener as (session: SessionLike, event: SessionEventLike) => void)(session, event)
    }
  }

  /** Announce a Session teardown. */
  emitSessionDisposed(session: SessionLike): void {
    for (const listener of [...(this.listeners.get('session/disposed') ?? [])]) {
      ;(listener as (session: SessionLike) => void)(session)
    }
  }

  /**
   * Run the tool waterfall for one pending call, which is also how a spec waits
   * for the Session's queued snapshot work to settle.
   * @param sessionId - the Session the call belongs to.
   * @param label - what the tool would do, recorded for ordering assertions.
   * @param body - the tool's own work, run inside `next` so it lands exactly
   *   where a real tool body would: after every gate ahead of it has released.
   * @returns the chain's decision.
   */
  async runGate(sessionId: string, label = 'tool', body?: () => Promise<void>): Promise<unknown> {
    let decision: unknown = 'allowed'
    const next = async (): Promise<unknown> => {
      await body?.()
      this.gateOrder.push(label)
      return decision
    }
    for (const listener of [...(this.listeners.get('tools/pre-execute') ?? [])]) {
      decision = await (listener as (exec: ToolExecutionLike, next: () => Promise<unknown>) => Promise<unknown>)(
        { name: label, agent: { session: { id: sessionId, header: {} } } },
        next,
      )
    }
    return decision
  }

  /** Dispose every registration, then run the plugin's own teardown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.disposers].reverse()) dispose()
    this.disposers.length = 0
    this.listeners.clear()
  }
}

/** A Session value as the append feed hands it to a listener. */
export function session(id: string, header: { cwd?: string; origin?: string; delegationDepth?: number } = {}): SessionLike {
  return { id, header } as SessionLike
}

/** A `turn/start` event. */
export function turnStart(turn: number): SessionEventLike {
  return { type: 'turn/start', data: { turn } }
}

/** A `turn/end` event. */
export function turnEnd(turn: number): SessionEventLike {
  return { type: 'turn/end', data: { turn, reason: { kind: 'stop' } } }
}
