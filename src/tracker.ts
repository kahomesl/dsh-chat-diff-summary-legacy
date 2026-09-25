/**
 * Per-Session turn tracking: the git working-tree snapshot taken when a turn
 * starts, the one taken when it ends, and the difference between them.
 *
 * The comparison is deliberately *working tree to working tree*, not
 * `git diff HEAD`: a file the user had already staged or left dirty before the
 * turn began is present in both snapshots, so it contributes nothing. This is
 * also why the tracker sees shell edits — `sed`, a Gradle task, a script — at
 * all: they move the same working tree the second snapshot reads.
 *
 * Every git write goes into a private scratch directory, never into the user's
 * repository. See `git.ts` for what that guarantees, and `tests/git.spec.ts` for
 * the hashes that prove it.
 *
 * A Session whose working directory no repository encloses is measured the same
 * way, through a private repository this plugin mints for that directory. That
 * repository is *shared per canonical working directory* and owned by
 * `synthetic-workspace.ts`: its first pass reads the whole directory once, so
 * one pass serves every Session in it, a pass that fails is retried later
 * instead of being remembered as permanent, and the turn that opens a cold
 * directory waits for the pass rather than losing its own changes. What stays
 * per-Session is only what cannot be shared: the open turn, its baseline tree
 * id, its summaries and whether a measurement is in flight.
 */
import type { CommandRunner, GitCallContext, GitDiagnostics, GitLogger, GitWorkspace, RawChange, ScratchMarker } from './git.ts'
import { GIT_TIMEOUT_MS, GIT_WARMUP_TIMEOUT_MS, SILENT_DIAGNOSTICS, createScratch, describeFailure, describeStep, diffSyntheticTrees, diffTrees, gitEnvironment, locateSyntheticWorkspace, locateWorkspace, removeScratch, resolveGit, snapshotSyntheticTree, snapshotTree } from './git.ts'
import { MAX_FILES, MAX_RETAINED_TURNS, PLUGIN_NAME, type ChangeSummary } from './summary.ts'
import type { SharedWorkspace, WorkspaceEngine } from './synthetic-workspace.ts'
import { SyntheticWorkspaces, WARMUP_GATE_BUDGET_MS } from './synthetic-workspace.ts'

/** Log prefix every line of this plugin carries. */
const PREFIX = 'chat-diff-summary-legacy:'

/** The snapshot operations the tracker needs; injected so it can be unit-tested without git. */
export interface ChangeEngine extends WorkspaceEngine {
  /** Resolve the repository enclosing `cwd`, or null when it is not inside one. */
  locate(cwd: string, scratch: () => Promise<string>, signal: AbortSignal, context?: GitCallContext): Promise<GitWorkspace | null>
  /** Write the work tree as a tree object under `label`'s private index, or null when git refused. */
  snapshot(workspace: GitWorkspace, label: string, signal: AbortSignal, context?: GitCallContext): Promise<string | null>
  /** Per-file counts between two snapshot trees. */
  diff(workspace: GitWorkspace, before: string, after: string, signal: AbortSignal, context?: GitCallContext): Promise<RawChange[]>
}

/** One Session's open-turn state. */
interface SessionRecord {
  readonly sessionId: string
  /** Serializes this Session's snapshot work, in the order the events arrived. */
  chain: Promise<void>
  /** The private directory holding this Session's snapshot indexes, on the repository path. */
  scratch: string | undefined
  /** The located workspace; `null` means the last attempt found none and the next turn retries. */
  workspace: GitWorkspace | null | undefined
  /** The shared synthetic workspace this Session holds, when no repository encloses its directory. */
  shared: SharedWorkspace | undefined
  /** The turn the state below belongs to. */
  turn: number
  /** The turn-start tree, or null when this turn has no usable baseline. */
  baseline: string | null
  /** Whether an in-turn measurement is already queued or running. */
  progressQueued: boolean
  /** When this Session was last measured mid-turn; 0 before the first one. */
  lastMeasuredAt: number
  /** Completed summaries by turn, newest last; bounded by {@link MAX_RETAINED_TURNS}. */
  readonly summaries: Map<number, ChangeSummary>
}

/** How long a route read waits for a turn whose measurement is still in flight. */
export const SUMMARY_WAIT_MS = 20_000

/**
 * Shortest gap between two in-turn measurements of one Session.
 *
 * A turn produces a tool result per mutating call, and every measurement is a
 * real `git add` over the work tree. The interval keeps a burst of calls from
 * walking the tree once each while still making the bar keep up with a working
 * agent; the turn's own end always measures, so a change dropped by this bound is
 * only ever late, never missing.
 */
export const PROGRESS_INTERVAL_MS = 400

/** A summary for a turn whose changes could not be computed; it draws as nothing. */
function emptySummary(turn: number): ChangeSummary {
  return { turn, files: [], total: 0, added: 0, deleted: 0 }
}

/** The basename of a slash-separated path. */
function basename(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? path : path.slice(cut + 1)
}

/**
 * Build one turn's wire summary from the raw diff.
 * @param turn - the summarized turn.
 * @param changes - per-file counts relative to the repository root.
 * @returns the summary, with `files` capped and `total` complete.
 */
export function summarize(turn: number, changes: readonly RawChange[]): ChangeSummary {
  const ordered = [...changes].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return {
    turn,
    files: ordered.slice(0, MAX_FILES).map((change) => ({
      path: change.path,
      // The row shows the bare basename, so a long path never squeezes the
      // counts off the line; the full path stays on the row's tooltip and in
      // `path`, which is also what keys the list.
      display: basename(change.path),
      added: change.added,
      deleted: change.deleted,
      ...change.binary ? { binary: true as const } : {},
    })),
    total: ordered.length,
    added: ordered.reduce((total, change) => total + change.added, 0),
    deleted: ordered.reduce((total, change) => total + change.deleted, 0),
  }
}

/** The real engine: git plumbing writing only into a private scratch directory. */
export function createGitEngine(runner: CommandRunner, executable: string, environment: Readonly<Record<string, string>>, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS): ChangeEngine {
  return {
    locate: (cwd, scratch, signal, context) => locateWorkspace(runner, executable, environment, cwd, scratch, signal, diagnostics, context),
    locateDirectory: (cwd, scratch, signal, context) => locateSyntheticWorkspace(runner, executable, environment, cwd, scratch, signal, diagnostics, context),
    snapshot: (workspace, label, signal, context) => snapshotTree(runner, executable, workspace, `${workspace.scratch}/index-${label}`, workspace.excludes, signal, diagnostics, context),
    snapshotDirectory: (workspace, warm, signal, context) => snapshotSyntheticTree(runner, executable, workspace, warm ? GIT_WARMUP_TIMEOUT_MS : GIT_TIMEOUT_MS, signal, diagnostics, context),
    diff: (workspace, before, after, signal, context) => workspace.synthetic === true
      ? diffSyntheticTrees(runner, executable, workspace, before, after, signal, diagnostics, context)
      : diffTrees(runner, executable, workspace, before, after, signal, diagnostics, context),
    createScratch: (kind: ScratchMarker['kind'], root) => createScratch('dsh-chat-diff-legacy', {
      schema: 1,
      plugin: PLUGIN_NAME,
      kind,
      ...root === undefined ? {} : { root },
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }),
    removeScratch: (scratch, context) => removeScratch(scratch, diagnostics, context),
  }
}

/** Report whether a Session mixes top-level and delegated turns. */
function isTopLevel(cwd: string | undefined, origin: string | undefined, depth: number): cwd is string {
  // Delegated Sessions own a child identity and would double-report the parent's
  // work; only top-level Sessions are summarized, exactly like the official
  // change service does.
  if (cwd === undefined || cwd === '') return false
  return origin !== 'subagent' && depth <= 0
}

/** One plugin instance's tracker over every live Session. */
export class TurnTracker {
  private readonly sessions = new Map<string, SessionRecord>()

  /**
   * @param engine - resolves the snapshot engine once, or null when this host has no git.
   * @param logger - host logger for contained failures.
   * @param lifetime - aborts every in-flight git call on plugin disposal.
   * @param synthetic - the shared synthetic workspaces; one registry serves every Session.
   */
  constructor(
    private readonly engine: EngineProvider,
    private readonly logger: GitLogger,
    private readonly lifetime: AbortSignal,
    private readonly synthetic: SyntheticWorkspaces = new SyntheticWorkspaces(logger, lifetime),
  ) {}

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
  beginTurn(sessionId: string, cwd: string | undefined, origin: string | undefined, delegationDepth: number, turn: number): void {
    // A Session this plugin does not track is never given a record at all, so it
    // holds no state and its route answer stays 204 rather than an empty summary.
    if (!isTopLevel(cwd, origin, delegationDepth)) return
    const record = this.recordFor(sessionId)
    record.turn = turn
    record.baseline = null
    this.enqueue(record, async (signal) => {
      const engine = await this.engine()
      if (engine === null) return
      const workspace = await this.workspaceFor(engine, record, cwd, signal)
      if (workspace === null) {
        this.logger.warn(`${PREFIX} session "${sessionId}": no workspace for "${cwd}", so turn ${turn} has no baseline`)
        return
      }
      const tree = await this.snapshotIn(engine, workspace, 'base', signal, { sessionId })
      if (record.turn === turn) record.baseline = tree
      if (tree === null) this.logger.warn(`${PREFIX} session "${sessionId}": turn ${turn} could not take its baseline snapshot`)
    })
  }

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
  progress(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    if (record === undefined || record.turn < 1) return
    // Nothing to measure against until the baseline exists; the tool gate
    // guarantees it before the first mutation, so this only skips a stray call.
    if (record.baseline === null || record.progressQueued) return
    const now = Date.now()
    if (record.lastMeasuredAt !== 0 && now - record.lastMeasuredAt < PROGRESS_INTERVAL_MS) return
    record.progressQueued = true
    this.enqueue(record, async (signal) => {
      try {
        const turn = record.turn
        const baseline = record.baseline
        if (baseline === null) return
        const engine = await this.engine()
        if (engine === null) return
        const workspace = record.workspace ?? null
        if (workspace === null) return
        const context: GitCallContext = { sessionId }
        const tree = await this.snapshotIn(engine, workspace, 'live', signal, context)
        if (tree === null) return
        const changes = await engine.diff(workspace, baseline, tree, signal, context)
        // The turn may have ended, or a new one opened, while git ran.
        if (record.turn !== turn || record.baseline !== baseline) return
        this.remember(record, summarize(turn, changes))
      } finally {
        record.progressQueued = false
        record.lastMeasuredAt = Date.now()
      }
    })
  }

  /**
   * Close a turn: queue the end snapshot, its diff, and the stored summary.
   *
   * The previous turn's summary stays readable while this one is being
   * computed, so a new turn never leaves the bar in a half-drawn state; the
   * summary is replaced, not cleared, the moment the diff is known.
   * @param sessionId - the Session whose turn closed.
   * @param turn - the turn number from the `turn/end` event.
   */
  endTurn(sessionId: string, turn: number): void {
    const record = this.sessions.get(sessionId)
    if (record === undefined || record.turn !== turn) return
    // The end measurement is authoritative, so it is never throttled.
    record.lastMeasuredAt = 0
    this.enqueue(record, async (signal) => {
      if (record.turn !== turn) return
      const workspace = record.workspace ?? null
      const baseline = record.baseline
      if (workspace === null || baseline === null) {
        // No repository, or no baseline this turn can be measured against:
        // record the turn as having nothing verifiable rather than re-serving
        // the previous turn's numbers as if they were this one's. The reason is
        // logged, because a turn that silently reports nothing is the failure
        // this plugin is most often asked about.
        const reason = workspace === null
          ? `no workspace${record.shared === undefined ? '' : ` (state=${record.shared.state}${record.shared.lastFailure === undefined ? '' : `, last failure: ${record.shared.lastFailure}`})`}`
          : 'no baseline snapshot'
        this.logger.warn(`${PREFIX} session "${sessionId}": turn ${turn} has ${reason}; reporting no changes for it`)
        this.remember(record, emptySummary(turn))
        return
      }
      const engine = await this.engine()
      if (engine === null) {
        this.remember(record, emptySummary(turn))
        return
      }
      const context: GitCallContext = { sessionId }
      const end = await this.snapshotIn(engine, workspace, 'end', signal, context)
      if (end === null) {
        this.logger.warn(`${PREFIX} session "${sessionId}": turn ${turn} could not take its closing snapshot; reporting no changes for it`)
        this.remember(record, emptySummary(turn))
        return
      }
      this.remember(record, summarize(turn, await engine.diff(workspace, baseline, end, signal, context)))
    })
  }

  /**
   * Resolve once this Session has no queued snapshot work.
   *
   * The host's tool gate awaits this before dispatching a call, which is what
   * keeps the baseline ahead of the turn's first mutation — including on a cold
   * synthetic workspace, whose first pass is queued here too.
   * @param sessionId - the Session about to run a tool.
   * @returns when every queued snapshot, diff, and record has settled.
   */
  async settle(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.chain
  }

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
  async completed(sessionId: string, turn?: number, waitMs = SUMMARY_WAIT_MS): Promise<ChangeSummary | undefined> {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return this.summary(sessionId, turn)
    // A read aimed at the turn this Session is still working on always waits for
    // the queued measurement, even when an earlier measurement already stands:
    // an open turn is re-measured after every settled tool call, and answering
    // from the previous one would show numbers that are already out of date.
    const pending = turn === undefined ? record.summaries.size === 0 : record.turn === turn
    if (!pending) return this.summary(sessionId, turn)
    await Promise.race([record.chain, new Promise((resolve) => setTimeout(resolve, waitMs))])
    return this.summary(sessionId, turn)
  }

  /**
   * Read one Session's summary as it stands right now.
   * @param sessionId - the Session to read.
   * @param turn - a specific turn, or omitted for the newest completed one.
   * @returns the summary, or undefined when this Session has none.
   */
  summary(sessionId: string, turn?: number): ChangeSummary | undefined {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return undefined
    if (turn !== undefined) return record.summaries.get(turn)
    let newest: ChangeSummary | undefined
    for (const [candidate, summary] of record.summaries) {
      if (newest === undefined || candidate > newest.turn) newest = summary
    }
    return newest
  }

  /** Forget one Session: release its share of the workspace and delete its own scratch. */
  async disposeSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return
    this.sessions.delete(sessionId)
    // The first pass of a synthetic workspace is queued on this chain, and a
    // repository-path snapshot always is, so waiting here is what keeps a
    // deletion from racing the git call that is still writing.
    await record.chain
    await this.synthetic.release(sessionId)
    if (record.scratch === undefined) return
    const engine = await this.engine()
    await engine?.removeScratch(record.scratch, { sessionId }).catch(() => {})
  }

  /** Forget every Session, then every shared workspace; used on plugin disposal. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)))
    await this.synthetic.disposeAll()
  }

  /** The Session's record, created on first sight. */
  private recordFor(sessionId: string): SessionRecord {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const record: SessionRecord = {
      sessionId,
      chain: Promise.resolve(),
      scratch: undefined,
      workspace: undefined,
      shared: undefined,
      turn: 0,
      baseline: null,
      progressQueued: false,
      lastMeasuredAt: 0,
      summaries: new Map(),
    }
    this.sessions.set(sessionId, record)
    return record
  }

  /** Append one step to the Session's chain; a failing step is logged, never rethrown. */
  private enqueue(record: SessionRecord, step: (signal: AbortSignal) => Promise<void>): void {
    record.chain = record.chain.then(async () => {
      if (this.lifetime.aborted) return
      try {
        await step(this.lifetime)
      } catch (error) {
        if (this.lifetime.aborted) return
        this.logger.warn(`${PREFIX} session "${record.sessionId}": ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /** Store one summary, keeping only the newest {@link MAX_RETAINED_TURNS} turns. */
  private remember(record: SessionRecord, summary: ChangeSummary): void {
    record.summaries.set(summary.turn, summary)
    while (record.summaries.size > MAX_RETAINED_TURNS) {
      const oldest = Math.min(...record.summaries.keys())
      record.summaries.delete(oldest)
    }
  }

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
  private async workspaceFor(engine: ChangeEngine, record: SessionRecord, cwd: string, signal: AbortSignal): Promise<GitWorkspace | null> {
    if (record.workspace !== undefined && record.workspace !== null) {
      // A synthetic workspace can still be warming, or still be backing off from
      // a failed pass; both are decided here, before this turn's baseline.
      if (record.shared !== undefined) await this.awaitFirstPass(record, engine, signal)
      return record.shared?.workspace ?? record.workspace
    }
    const context: GitCallContext = { sessionId: record.sessionId }
    // The scratch is created lazily: only a directory that turns out to be inside
    // a repository needs the private index and store it holds.
    const located = await engine.locate(cwd, async () => (record.scratch ??= await engine.createScratch('repository', cwd)), signal, context)
    if (located !== null) {
      record.workspace = located
      return located
    }
    if (record.shared === undefined) {
      const prepared = await this.synthetic.prepare(record.sessionId, cwd, engine, signal, WARMUP_GATE_BUDGET_MS)
      record.shared = prepared.entry
      record.workspace = prepared.workspace
      // A cold workspace that did not finish inside the budget says so here, with
      // the same line a later turn would print: the turn is not silently empty.
      if (prepared.entry !== undefined && !prepared.ready) await this.awaitFirstPass(record, engine, signal)
      return prepared.workspace
    }
    await this.awaitFirstPass(record, engine, signal)
    record.workspace = record.shared.workspace ?? null
    return record.workspace
  }

  /**
   * Wait for this Session's shared first pass, and say so when a turn opens
   * before it is ready.
   *
   * The wait is what makes a cold turn measurable: the pass is the only way to
   * know what the directory looked like, so the turn's baseline cannot be taken
   * before it. Past the budget the turn proceeds without one, which the log
   * states plainly; the pass keeps running for the turns after it.
   */
  private async awaitFirstPass(record: SessionRecord, engine: ChangeEngine, signal: AbortSignal): Promise<void> {
    const entry = record.shared
    if (entry === undefined || entry.state === 'ready') return
    const started = Date.now()
    const ready = await this.synthetic.ready(entry, engine, signal, WARMUP_GATE_BUDGET_MS)
    if (ready) return
    this.logger.warn(`${PREFIX} session "${record.sessionId}": turn ${record.turn} opened ${String(Date.now() - started)}ms into this directory's first pass, which is not ready (state=${entry.state}${entry.lastFailure === undefined ? '' : `, last failure: ${entry.lastFailure}`}); the turn may report nothing, and the next turn inherits the pass`)
  }

  /** Snapshot the work tree the way this Session's workspace is measured. */
  private async snapshotIn(engine: ChangeEngine, workspace: GitWorkspace, label: string, signal: AbortSignal, context: GitCallContext): Promise<string | null> {
    if (workspace.synthetic === true) return engine.snapshotDirectory(workspace, false, signal, context)
    return engine.snapshot(workspace, label, signal, context)
  }
}

/** Resolve the real engine, or null when this host has no usable git. */
export type EngineProvider = () => Promise<ChangeEngine | null>

/** Resolve the real git engine once, or null when this host has no usable git. */
export function createEngineProvider(runner: CommandRunner, logger: GitLogger, signal: AbortSignal): EngineProvider {
  let resolved: Promise<ChangeEngine | null> | undefined
  // Every git step this plugin takes reports through here, so a failure names
  // the step, the directory, the exit code, git's own words and what it cost.
  const diagnostics: GitDiagnostics = {
    failed: (event) => logger.warn(describeFailure(event)),
    step: (event) => logger.info?.(describeStep(event)),
  }
  return () => {
    resolved ??= (async () => {
      const environment = gitEnvironment()
      const executable = await resolveGit(runner, environment, signal)
      if (executable === null) {
        logger.warn(`${PREFIX} git is unavailable; change summaries are disabled`)
        return null
      }
      return createGitEngine(runner, executable, environment, diagnostics)
    })()
    return resolved
  }
}
