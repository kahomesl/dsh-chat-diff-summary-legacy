//#region src/host.d.ts
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
interface SessionEventLike {
  readonly type: string;
  readonly data?: unknown;
}
/** The Session header fields this plugin reads. */
interface SessionHeaderLike {
  /** Absolute working directory the Session was created in, if any. */
  readonly cwd?: string;
  /** Coarse product classification; `'subagent'` for a delegated child Session. */
  readonly origin?: string;
  /** Delegation depth below a top-level Session; absent means zero. */
  readonly delegationDepth?: number;
}
/** A live Session, as far as this plugin reads it. */
interface SessionLike {
  readonly id: string;
  readonly header: SessionHeaderLike;
}
/** The agent a pending tool call runs on behalf of. */
interface AgentLike {
  readonly session: SessionLike;
}
/** One pending tool call, as far as the change gate reads it. */
interface ToolExecutionLike {
  readonly name?: string;
  readonly agent?: AgentLike;
}
/** One exact Fetch route registration. */
interface FetchRoute {
  readonly path: string;
  readonly methods: readonly string[];
  readonly requestBody: 'buffered' | 'stream';
  fetch(request: Request): Promise<Response>;
}
/** Listener options Cordis 4.0.2 accepts; `global` bypasses scope dispatch filtering. */
interface ListenerOptions {
  readonly global?: boolean;
  readonly prepend?: boolean;
}
/** The Cordis host context this plugin's node half runs against. */
interface HostContext {
  readonly connection: {
    readonly fetch: {
      register(route: FetchRoute): () => void;
    };
  };
  readonly logger: {
    warn(message: string): void;
    info(message: string): void;
  };
  /** Register a listener owned by this plugin's fiber; Cordis disposes it on unload. */
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void, options?: ListenerOptions): () => void;
  on(name: 'session/disposed', listener: (session: SessionLike) => void, options?: ListenerOptions): () => void;
  on(name: 'tools/pre-execute', listener: (exec: ToolExecutionLike, next: () => Promise<unknown>) => Promise<unknown>, options?: ListenerOptions): () => void;
  /**
   * Register a disposer owned by this plugin's fiber.
   *
   * An async disposer is awaited by the Loader, which is how the tracker's
   * scratch directories are guaranteed to be gone before the plugin is.
   */
  effect(callback: () => (() => void | Promise<void>) | void, label?: string): void;
}
//#endregion
//#region src/git.d.ts
/** The repository enclosing a Session working directory, and the private store its snapshots write to. */
interface GitWorkspace {
  /** Repository top level; the root every reported diff path is relative to. */
  readonly root: string;
  /** Absolute git directory holding the repository's index. */
  readonly gitDir: string;
  /** Canonical scratch directory holding the private object store and each snapshot's index. */
  readonly scratch: string;
  /** Environment routing object writes to the private store and object reads through the repository's store. */
  readonly env: Readonly<Record<string, string>>;
  /** Work-tree paths a snapshot must skip: the private directory, when it happens to lie inside the work tree. */
  readonly excludes: readonly string[];
}
/** One changed path between two snapshot trees. */
interface RawChange {
  /** Post-image path, relative to the repository root. A deletion keeps its pre-image path. */
  readonly path: string;
  readonly added: number;
  readonly deleted: number;
  readonly binary: boolean;
}
/** Minimal subset of the host logger this module uses. */
interface GitLogger {
  warn(message: string): void;
}
//#endregion
//#region src/summary.d.ts
/** One changed file, as the route reports it. */
interface ChangedFile {
  /** Repository-root-relative, slash-separated path. */
  readonly path: string;
  /** Short label for the compact list: the basename when it is unique, else the full path. */
  readonly display: string;
  /** Lines added; 0 for a binary file, which this plugin never counts. */
  readonly added: number;
  /** Lines deleted; 0 for a binary file. */
  readonly deleted: number;
  /** Present and true when git could not compute line counts for this file. */
  readonly binary?: true;
}
/** One completed turn's working-tree change summary. */
interface ChangeSummary {
  /** The turn whose changes this describes. */
  readonly turn: number;
  /** Changed files in path order, already capped; `total` stays complete. */
  readonly files: readonly ChangedFile[];
  /** Complete changed-file count, including files the cap omitted. */
  readonly total: number;
  /** Lines added over every counted file. */
  readonly added: number;
  /** Lines deleted over every counted file. */
  readonly deleted: number;
}
//#endregion
//#region src/tracker.d.ts
/** The snapshot operations the tracker needs; injected so it can be unit-tested without git. */
interface ChangeEngine {
  /** Resolve the repository enclosing `cwd`, or null when it is not inside one. */
  locate(cwd: string, scratch: string, signal: AbortSignal): Promise<GitWorkspace | null>;
  /** Write the work tree as a tree object under `label`'s private index, or null when git refused. */
  snapshot(workspace: GitWorkspace, label: string, signal: AbortSignal): Promise<string | null>;
  /** Per-file counts between two snapshot trees. */
  diff(workspace: GitWorkspace, before: string, after: string, signal: AbortSignal): Promise<RawChange[]>;
  /** Create one Session's private scratch directory. */
  createScratch(): Promise<string>;
  /** Remove one Session's private scratch directory. */
  removeScratch(scratch: string): Promise<void>;
}
/** One plugin instance's tracker over every live Session. */
declare class TurnTracker {
  private readonly engine;
  private readonly logger;
  private readonly lifetime;
  private readonly sessions;
  /**
   * @param engine - resolves the snapshot engine once, or null when this host has no git.
   * @param logger - host logger for contained failures.
   * @param lifetime - aborts every in-flight git call on plugin disposal.
   */
  constructor(engine: EngineProvider, logger: GitLogger, lifetime: AbortSignal);
  /**
   * Open a turn: reset the baseline and queue its snapshot.
   *
   * The snapshot is asynchronous because it is a real git call; the host gates
   * tool dispatch on {@link settle}, so nothing can mutate the work tree between
   * the turn's first tool call and the baseline being written.
   * @param sessionId - the Session whose turn opened.
   * @param cwd - the Session working directory, absent for a Session without one.
   * @param origin - the Session's coarse product origin.
   * @param delegationDepth - how deep below a top-level Session this one sits.
   * @param turn - the turn number from the `turn/start` event.
   */
  beginTurn(sessionId: string, cwd: string | undefined, origin: string | undefined, delegationDepth: number, turn: number): void;
  /**
   * Re-measure the open turn without closing it, so the bar can follow a turn
   * while it runs rather than only once it ends.
   *
   * The measurement is the same baseline-to-work-tree diff the turn's end will
   * take; it simply replaces the turn's stored summary early. Calls are coalesced
   * two ways: one measurement is in flight at a time, and two measurements of the
   * same Session are never closer together than {@link PROGRESS_INTERVAL_MS}.
   * @param sessionId - the Session whose turn is still open.
   */
  progress(sessionId: string): void;
  /**
   * Close a turn: queue the end snapshot, its diff, and the stored summary.
   *
   * The previous turn's summary stays readable while this one is being
   * computed, so a new turn never leaves the bar in a half-drawn state; the
   * summary is replaced, not cleared, the moment the diff is known.
   * @param sessionId - the Session whose turn closed.
   * @param turn - the turn number from the `turn/end` event.
   */
  endTurn(sessionId: string, turn: number): void;
  /**
   * Resolve once this Session has no queued snapshot work.
   *
   * The host's tool gate awaits this before dispatching a call, which is what
   * keeps the baseline ahead of the turn's first mutation.
   * @param sessionId - the Session about to run a tool.
   * @returns when every queued snapshot, diff, and record has settled.
   */
  settle(sessionId: string): Promise<void>;
  /**
   * Read one Session's summary, waiting for a turn whose measurement is still
   * in flight.
   *
   * `turn/end` reaches this tracker synchronously, but its end snapshot and diff
   * are real git calls. A browser that observes the turn boundary and asks
   * immediately would otherwise be told "nothing" for a turn that is merely
   * still being measured — and would have no reason to ask again. Waiting for
   * the Session's queued work closes that race at the source, so one request
   * still answers the question.
   * @param sessionId - the Session to read.
   * @param turn - a specific turn, or omitted for the newest completed one.
   * @param waitMs - how long to wait for a measurement already under way.
   * @returns the summary, or undefined when this Session has none.
   */
  completed(sessionId: string, turn?: number, waitMs?: number): Promise<ChangeSummary | undefined>;
  /**
   * Read one Session's summary as it stands right now.
   * @param sessionId - the Session to read.
   * @param turn - a specific turn, or omitted for the newest completed one.
   * @returns the summary, or undefined when this Session has none.
   */
  summary(sessionId: string, turn?: number): ChangeSummary | undefined;
  /** Forget one Session and delete everything the tracker wrote for it. */
  disposeSession(sessionId: string): Promise<void>;
  /** Forget every Session; used on plugin disposal. */
  dispose(): Promise<void>;
  /** The Session's record, created on first sight. */
  private recordFor;
  /** Append one step to the Session's chain; a failing step is logged, never rethrown. */
  private enqueue;
  /** Store one summary, keeping only the newest {@link MAX_RETAINED_TURNS} turns. */
  private remember;
  /** Locate the Session's repository once, retrying while no repository exists yet. */
  private workspaceFor;
}
/** Resolve the real engine, or null when this host has no usable git. */
type EngineProvider = () => Promise<ChangeEngine | null>;
//#endregion
//#region src/index.d.ts
/** Stable Loader identity; the browser half declares the same name. */
declare const name = "chat-diff-summary-legacy";
/** Services required before the summary route can be registered. */
declare const inject: readonly ["connection"];
/**
 * Answer the summary route for one Session.
 *
 * The route reads nothing but this plugin's own per-Session records: it carries
 * no path, no command, and no repository handle, so it cannot be turned into a
 * general git API by a caller.
 * @param tracker - the plugin's live tracker.
 * @param request - the authenticated request.
 * @returns the summary JSON, or the status explaining its absence.
 */
declare function handleSummary(tracker: TurnTracker, request: Request): Promise<Response>;
/**
 * Register turn tracking and the summary route.
 * @param ctx - host context carrying `connection`.
 */
declare function apply(ctx: HostContext): void;
//#endregion
export { apply, handleSummary, inject, name };