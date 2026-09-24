/**
 * The browser-side services this plugin consumes, declared structurally.
 *
 * Like `src/host.ts`, nothing here imports a `@deepseek-ai/*` package: the
 * target line's shipped declarations are not the ones this legacy build must be
 * written against. Every member is quoted from a 0.1.5-rc.2 shipped client
 * plugin:
 *
 * - `sessions.binding(id)` → `{ sessionId, session, eventSource, ctx }`, with
 *   `eventSource.getSnapshot()`/`subscribe()` — `@deepseek-ai/dsh-api-session-controller`.
 * - the window entries are `{ type: 'event' | 'transient', event }` —
 *   `@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/events.d.ts`.
 * - `slots.inject(name, mount)` and `slots.register(options, component)` —
 *   `@deepseek-ai/dsh-client-ui-conversation` and `ui-goal`.
 * - `locale.register(namespace, dictionaries)` — `@deepseek-ai/dsh-client-locale`.
 * - the injected props face accepts `hooks`, whose names the renderer turns into
 *   `use<Name>` component props — `ui-goal`'s `goalActivation`.
 * - `on('connection/reset', …)`, `effect(callback, label)` — Cordis built-ins.
 */

/** One durable Session event, as far as the browser half reads it. */
export interface AnnouncedEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** One entry of the Session event window. */
export interface EventEntryLike {
  readonly type?: string
  readonly event: AnnouncedEvent
}

/** The contiguous Session event window a binding exposes. */
export interface EventWindowLike {
  readonly entries: readonly EventEntryLike[]
}

/** One Session's client-side assembly feed. */
export interface EventSourceLike {
  getSnapshot(): EventWindowLike
  subscribe(listener: () => void): () => void
}

/** One Session's client binding. */
export interface SessionBindingLike {
  readonly sessionId: string
  readonly eventSource: EventSourceLike
}

/** A framework-observable snapshot source, as a `hooks` entry delivers it. */
export interface ObservableLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** One dock registration's options, narrowed to what this plugin passes. */
export interface SlotRegistration {
  readonly name: string
  readonly id: string
  readonly order: number
  readonly locale?: string
  readonly inject?: (sessionId: string) => Record<string, unknown>
}

/** The Cordis client context this plugin's browser half runs against. */
export interface ClientContext {
  readonly sessions: { binding(id: string): SessionBindingLike | undefined }
  readonly locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void }
  readonly slots: {
    inject(name: string, mount: () => (() => void) | void): void
    register(options: SlotRegistration, component: unknown): () => void
  }
  on(name: 'connection/reset', listener: () => void): () => void
  /** Register a disposer owned by this plugin's fiber. */
  effect(callback: () => (() => void) | void, label?: string): void
}
