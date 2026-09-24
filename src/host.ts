/**
 * The host services this plugin consumes, declared structurally.
 *
 * This plugin targets DeepSeek Harness 0.1.5-rc.2, whose published packages
 * ship no `.d.ts` at all through the DSH Desktop 2.0.13 bundle; more to the
 * point, a legacy build must not import host packages whose shapes belong to a
 * later line. Every member below is quoted from a 0.1.5-rc.2 shipped plugin:
 *
 * - `on('session/event', (session, event), { global: true })` —
 *   `@deepseek-ai/dsh-session/lib/invariant.js` and
 *   `@deepseek-ai/dsh-compaction/lib/invariant.js` register exactly this, with
 *   `global: true` to bypass the `@deepseek-ai/dsh-scope` dispatch filter.
 * - `on('session/disposed', (session))` — the paired teardown announcement.
 * - `on('tools/pre-execute', (exec, next))` — a waterfall, as registered by
 *   `@deepseek-ai/dsh-hooks-claude-code`, `dsh-hooks-codex` and `dsh-tool-jobs`.
 * - `connection.fetch.register({ path, methods, requestBody, fetch })` —
 *   `@deepseek-ai/dsh-client-ui-deliverables/lib/index.js`.
 * - `effect(callback, label)` and `logger` — Cordis 4.0.2 built-ins.
 */

/** One durable Session event, as far as this plugin reads it. */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

/** The Session header fields this plugin reads. */
export interface SessionHeaderLike {
  /** Absolute working directory the Session was created in, if any. */
  readonly cwd?: string
  /** Coarse product classification; `'subagent'` for a delegated child Session. */
  readonly origin?: string
  /** Delegation depth below a top-level Session; absent means zero. */
  readonly delegationDepth?: number
}

/** A live Session, as far as this plugin reads it. */
export interface SessionLike {
  readonly id: string
  readonly header: SessionHeaderLike
}

/** The agent a pending tool call runs on behalf of. */
export interface AgentLike {
  readonly session: SessionLike
}

/** One pending tool call, as far as the change gate reads it. */
export interface ToolExecutionLike {
  readonly name?: string
  readonly agent?: AgentLike
}

/** One exact Fetch route registration. */
export interface FetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: 'buffered' | 'stream'
  fetch(request: Request): Promise<Response>
}

/** Listener options Cordis 4.0.2 accepts; `global` bypasses scope dispatch filtering. */
export interface ListenerOptions {
  readonly global?: boolean
  readonly prepend?: boolean
}

/** The Cordis host context this plugin's node half runs against. */
export interface HostContext {
  readonly connection: { readonly fetch: { register(route: FetchRoute): () => void } }
  readonly logger: { warn(message: string): void; info(message: string): void }
  /** Register a listener owned by this plugin's fiber; Cordis disposes it on unload. */
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void, options?: ListenerOptions): () => void
  on(name: 'session/disposed', listener: (session: SessionLike) => void, options?: ListenerOptions): () => void
  on(name: 'tools/pre-execute', listener: (exec: ToolExecutionLike, next: () => Promise<unknown>) => Promise<unknown>, options?: ListenerOptions): () => void
  /**
   * Register a disposer owned by this plugin's fiber.
   *
   * An async disposer is awaited by the Loader, which is how the tracker's
   * scratch directories are guaranteed to be gone before the plugin is.
   */
  effect(callback: () => (() => void | Promise<void>) | void, label?: string): void
}
