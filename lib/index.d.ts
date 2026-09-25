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
  /**
   * True when this workspace was minted for a directory no repository encloses.
   *
   * A synthetic workspace carries its own private repository: `gitDir` is a
   * directory this plugin created under `scratch`, `env` points git at it, and
   * the work tree is the Session's own directory. Nothing is written inside the
   * work tree — the only trace of the workspace is `scratch`, which the Session
   * removes when it ends.
   */
  readonly synthetic?: true;
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
  /** Optional: step costs and lifecycle notes; absent means "failures only". */
  info?(message: string): void;
}
/** Per-call identity the engine carries into every diagnostic it reports. */
interface GitCallContext {
  /** Session whose turn drove this call, when one did. */
  readonly sessionId?: string;
  /** Which attempt of a synthetic workspace's first pass this call belongs to. */
  readonly attempt?: number;
}
/** One step that failed, with everything needed to place it. */
interface GitFailure extends GitCallContext {
  /** The step that failed, in git's own terms: `git init`, `add --all`, `write-tree`, … */
  readonly operation: string;
  /** How long the step ran before it failed. */
  readonly elapsedMs: number;
  /** Working directory or repository root the step addressed. */
  readonly root?: string;
  /** Process exit code, or null when the process never started. */
  readonly exitCode?: number | null;
  /** git's own words, truncated; never a path the plugin added. */
  readonly stderr?: string;
  /** What the caller concluded, when the failure has no exit code. */
  readonly detail?: string;
}
/** One step that finished, reported for the steps whose cost is the story. */
interface GitStep extends GitCallContext {
  readonly operation: string;
  readonly elapsedMs: number;
  readonly root?: string;
  readonly detail?: string;
}
/** Where the engine reports what it did. */
interface GitDiagnostics {
  failed(event: GitFailure): void;
  step(event: GitStep): void;
}
/**
 * What a scratch directory says about itself.
 *
 * The marker is what makes cleanup safe: a directory is only ever removed when
 * this file names this plugin. Name matching alone is not enough — another
 * program's temporary directory may share the prefix, and deleting by prefix
 * would be a data-loss bug, not a cleanup.
 */
interface ScratchMarker {
  /** Bumped when this shape changes; an unknown schema is never removed. */
  readonly schema: 1;
  /** Owning plugin, matched exactly before anything is deleted. */
  readonly plugin: string;
  /** What the directory holds. */
  readonly kind: 'repository' | 'synthetic';
  /** Working directory the snapshots measure. */
  readonly root?: string;
  /** Host process that created it, for a reader's benefit only. */
  readonly pid: number;
  readonly createdAt: string;
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
//#region src/synthetic-workspace.d.ts
/** The subset of the snapshot engine this registry drives; the tracker owns the rest. */
interface WorkspaceEngine {
  /** Mint a private repository for a directory no repository encloses, or null when git refused. */
  locateDirectory(cwd: string, scratch: string, signal: AbortSignal, context?: GitCallContext): Promise<GitWorkspace | null>;
  /** Refresh a synthetic workspace's own index; `warm` selects the first, whole-directory bound. */
  snapshotDirectory(workspace: GitWorkspace, warm: boolean, signal: AbortSignal, context?: GitCallContext): Promise<string | null>;
  /** Create one private scratch directory, marked as this plugin's own. */
  createScratch(kind: ScratchMarker['kind'], root: string | undefined): Promise<string>;
  /** Remove one private scratch directory. */
  removeScratch(scratch: string, context?: GitCallContext): Promise<void>;
}
/** How far a synthetic workspace's first, whole-directory pass has got. */
type WarmState = 'cold' | 'warming' | 'ready' | 'failed';
/** One shared synthetic workspace and everything known about it. */
interface SharedWorkspace {
  /** Canonical key: `realpath(cwd)`, case-folded on Windows. */
  readonly key: string;
  /** Canonical working directory this workspace measures. */
  readonly root: string;
  /** The private directory holding the repository, its objects and its index. */
  readonly scratch: string;
  /** The synthetic repository, once a pass has minted it. */
  workspace: GitWorkspace | null;
  /** How far the first pass has got. */
  state: WarmState;
  /** Passes started so far, which is also what the backoff is computed from. */
  attempts: number;
  /** The pass in flight, or the last one that ran; every consumer awaits this same promise. */
  warm: Promise<boolean> | undefined;
  /** Earliest time the next pass may start, after a failure. */
  retryAt: number;
  /** Sessions currently holding this workspace. */
  readonly consumers: Set<string>;
  /** When the last consumer last touched it. */
  lastUsed: number;
  /** Pending retirement, cancelled when a consumer claims the workspace again. */
  retireTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the last failure said, so a later attempt can name it. */
  lastFailure: string | undefined;
  /** The engine that created it, which is the one that can remove it. */
  engine: WorkspaceEngine | undefined;
}
/** What one Session gets back from {@link SyntheticWorkspaces.prepare}. */
interface PreparedWorkspace {
  /** The shared entry, to be handed back to {@link SyntheticWorkspaces.release}. */
  readonly entry: SharedWorkspace | undefined;
  /** The repository, or null when it could not be minted (yet). */
  readonly workspace: GitWorkspace | null;
  /** Whether the first pass has finished, so this turn can be measured. */
  readonly ready: boolean;
}
/** Tuning knobs; the defaults are what the plugin runs with. */
interface SyntheticWorkspaceOptions {
  /** How long a workspace with no consumers is kept before its scratch is removed. */
  readonly idleMs?: number;
  /** First backoff after a failed pass. */
  readonly backoffBaseMs?: number;
  /** Ceiling for that backoff, however many attempts fail. */
  readonly backoffMaxMs?: number;
  /** Injectable clock, so a spec can drive the backoff without waiting. */
  readonly now?: () => number;
  /** Where step costs and failures are reported. */
  readonly diagnostics?: GitDiagnostics;
}
/** The registry of shared synthetic workspaces. */
declare class SyntheticWorkspaces {
  private readonly logger;
  private readonly lifetime;
  private readonly options;
  private readonly entries;
  private readonly claimed;
  private disposed;
  constructor(logger: GitLogger, lifetime: AbortSignal, options?: SyntheticWorkspaceOptions);
  /** The clock the backoff is measured against. */
  private get now();
  /** The diagnostics sink, with `info` routed to the logger when it has one. */
  private get diagnostics();
  /** Every entry currently held, for diagnostics and specs. */
  entriesHeld(): readonly SharedWorkspace[];
  /**
   * Claim the workspace for one Session and get it as ready as the budget allows.
   *
   * Claiming is idempotent per Session: a second call for the same Session and
   * directory returns the same entry and does not disturb the pass in flight.
   * @param sessionId - the Session that will measure turns here.
   * @param cwd - the Session working directory, outside any repository.
   * @param engine - the snapshot engine that mints and warms the workspace.
   * @param signal - cancellation.
   * @param budgetMs - how long this caller may be kept waiting for the first pass.
   * @returns the entry, the repository and whether it is ready.
   */
  prepare(sessionId: string, cwd: string, engine: WorkspaceEngine, signal: AbortSignal, budgetMs: number): Promise<PreparedWorkspace>;
  /**
   * Make a claimed workspace as ready as the budget allows.
   *
   * This is what a turn calls before it snapshots its baseline. A pass already
   * in flight is awaited rather than started again, so N Sessions arriving at a
   * cold directory produce one pass, not N.
   * @param entry - the shared workspace.
   * @param engine - the snapshot engine.
   * @param signal - cancellation.
   * @param budgetMs - how long this caller may wait; the pass itself is never cut short by it.
   * @returns whether the first pass has finished.
   */
  ready(entry: SharedWorkspace, engine: WorkspaceEngine, signal: AbortSignal, budgetMs: number): Promise<boolean>;
  /** The entry's warm state, read through a call so a caller's narrowing cannot mask a pass landing. */
  private stateOf;
  /**
   * Run one first pass and settle the entry's state when it lands.
   *
   * The pass is never cancelled by a caller's budget: it is the expensive work
   * every later turn depends on, so it runs to its own git timeout and reports
   * its outcome to whoever is still holding the workspace.
   */
  private runPass;
  /** Record one failed pass and put the entry back into a retryable state. */
  private fail;
  /** Exponential backoff, capped; never zero, so a failing pass cannot spin. */
  private backoff;
  /** Wait for `work`, but no longer than `budgetMs`; an unbounded budget waits it out. */
  private withinBudget;
  /** Let one Session stop holding its workspace; the last one out starts the idle clock. */
  release(sessionId: string): Promise<void>;
  /** Remove one unclaimed workspace: wait for its pass, then delete its scratch. */
  private retire;
  /** Retire every workspace at once; used on plugin disposal. */
  disposeAll(): Promise<void>;
  /** Log one lifecycle note when the host logger carries `info`. */
  private info;
}
//#endregion
//#region src/tracker.d.ts
/** The snapshot operations the tracker needs; injected so it can be unit-tested without git. */
interface ChangeEngine extends WorkspaceEngine {
  /** Resolve the repository enclosing `cwd`, or null when it is not inside one. */
  locate(cwd: string, scratch: () => Promise<string>, signal: AbortSignal, context?: GitCallContext): Promise<GitWorkspace | null>;
  /** Write the work tree as a tree object under `label`'s private index, or null when git refused. */
  snapshot(workspace: GitWorkspace, label: string, signal: AbortSignal, context?: GitCallContext): Promise<string | null>;
  /** Per-file counts between two snapshot trees. */
  diff(workspace: GitWorkspace, before: string, after: string, signal: AbortSignal, context?: GitCallContext): Promise<RawChange[]>;
}
/** One plugin instance's tracker over every live Session. */
declare class TurnTracker {
  private readonly engine;
  private readonly logger;
  private readonly lifetime;
  private readonly synthetic;
  private readonly sessions;
  /**
   * @param engine - resolves the snapshot engine once, or null when this host has no git.
   * @param logger - host logger for contained failures.
   * @param lifetime - aborts every in-flight git call on plugin disposal.
   * @param synthetic - the shared synthetic workspaces; one registry serves every Session.
   */
  constructor(engine: EngineProvider, logger: GitLogger, lifetime: AbortSignal, synthetic?: SyntheticWorkspaces);
  /**
   * Open a turn: reset the baseline and queue its snapshot.
   *
   * The snapshot is asynchronous because it is a real git call; the host gates
   * tool dispatch on {@link settle}, so nothing can mutate the work tree between
   * the turn's first tool call and the baseline being written. A synthetic
   * workspace's first pass is queued on the same chain for that reason: waiting
   * is what keeps a cold turn's own changes from being invisible. The wait is
   * bounded by {@link WARMUP_GATE_BUDGET_MS}; a pass that outlives it keeps
   * running for the next turn, and the turn it outlived says so in the log.
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
   * keeps the baseline ahead of the turn's first mutation — including on a cold
   * synthetic workspace, whose first pass is queued here too.
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
  /** Forget one Session: release its share of the workspace and delete its own scratch. */
  disposeSession(sessionId: string): Promise<void>;
  /** Forget every Session, then every shared workspace; used on plugin disposal. */
  dispose(): Promise<void>;
  /** The Session's record, created on first sight. */
  private recordFor;
  /** Append one step to the Session's chain; a failing step is logged, never rethrown. */
  private enqueue;
  /** Store one summary, keeping only the newest {@link MAX_RETAINED_TURNS} turns. */
  private remember;
  /**
   * Resolve the Session's workspace: the repository enclosing `cwd`, or the
   * shared private repository for a directory no repository encloses.
   *
   * A Session keeps the workspace it first resolved, because a baseline tree only
   * means anything in the object store it was written to, and switching stores
   * mid-Session would compare a tree the other store cannot resolve. A directory
   * that gains a repository later is measured by the repository path from the
   * next Session on.
   * @param engine - the resolved snapshot engine.
   * @param record - the Session's record.
   * @param cwd - the Session working directory.
   * @param signal - cancellation.
   * @returns the workspace, or null when git could not address the directory at all.
   */
  private workspaceFor;
  /**
   * Wait for this Session's shared first pass, and say so when a turn opens
   * before it is ready.
   *
   * The wait is what makes a cold turn measurable: the pass is the only way to
   * know what the directory looked like, so the turn's baseline cannot be taken
   * before it. Past the budget the turn proceeds without one, which the log
   * states plainly; the pass keeps running for the turns after it.
   */
  private awaitFirstPass;
  /** Snapshot the work tree the way this Session's workspace is measured. */
  private snapshotIn;
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