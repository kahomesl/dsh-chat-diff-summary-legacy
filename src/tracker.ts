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
 * Each Session owns one private scratch directory, and every git write goes
 * into it. See `git.ts` for what that guarantees, and `tests/git.spec.ts` for
 * the hashes that prove it.
 */
import type { CommandRunner, GitLogger, GitWorkspace, RawChange } from './git.ts'
import { createScratch, diffTrees, gitEnvironment, locateWorkspace, removeScratch, resolveGit, snapshotTree } from './git.ts'
import { MAX_FILES, MAX_RETAINED_TURNS, type ChangeSummary } from './summary.ts'

/** The snapshot operations the tracker needs; injected so it can be unit-tested without git. */
export interface ChangeEngine {
  /** Resolve the repository enclosing `cwd`, or null when it is not inside one. */
  locate(cwd: string, scratch: string, signal: AbortSignal): Promise<GitWorkspace | null>
  /** Write the work tree as a tree object under `label`'s private index, or null when git refused. */
  snapshot(workspace: GitWorkspace, label: string, signal: AbortSignal): Promise<string | null>
  /** Per-file counts between two snapshot trees. */
  diff(workspace: GitWorkspace, before: string, after: string, signal: AbortSignal): Promise<RawChange[]>
  /** Create one Session's private scratch directory. */
  createScratch(): Promise<string>
  /** Remove one Session's private scratch directory. */
  removeScratch(scratch: string): Promise<void>
}

/** One Session's open-turn state. */
interface SessionRecord {
  readonly sessionId: string
  /** Serializes this Session's snapshot work, in the order the events arrived. */
  chain: Promise<void>
  /** The private directory holding this Session's snapshot objects and indexes. */
  scratch: string | undefined
  /** The located repository; `null` means the last attempt found none and the next turn retries. */
  workspace: GitWorkspace | null | undefined
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

/** The real engine: git plumbing writing only into the Session's scratch directory. */
export function createGitEngine(runner: CommandRunner, executable: string, environment: Readonly<Record<string, string>>): ChangeEngine {
  return {
    locate: (cwd, scratch, signal) => locateWorkspace(runner, executable, environment, cwd, () => Promise.resolve(scratch), signal),
    snapshot: (workspace, label, signal) => snapshotTree(runner, executable, workspace, `${workspace.scratch}/index-${label}`, workspace.excludes, signal),
    diff: (workspace, before, after, signal) => diffTrees(runner, executable, workspace, before, after, signal),
    createScratch: () => createScratch('dsh-chat-diff-legacy'),
    removeScratch: (scratch) => removeScratch(scratch),
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
   */
  constructor(
    private readonly engine: EngineProvider,
    private readonly logger: GitLogger,
    private readonly lifetime: AbortSignal,
  ) {}

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
  beginTurn(sessionId: string, cwd: string | undefined, origin: string | undefined, delegationDepth: number, turn: number): void {
    // A Session this plugin does not track is never given a record at all, so it
    // holds no state and its route answer stays 404 rather than an empty summary.
    if (!isTopLevel(cwd, origin, delegationDepth)) return
    const record = this.recordFor(sessionId)
    record.turn = turn
    record.baseline = null
    this.enqueue(record, async (signal) => {
      const engine = await this.engine()
      if (engine === null) return
      const workspace = await this.workspaceFor(engine, record, cwd, signal)
      if (workspace === null) return
      const tree = await engine.snapshot(workspace, 'base', signal)
      if (record.turn === turn) record.baseline = tree
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
        const tree = await engine.snapshot(workspace, 'live', signal)
        if (tree === null) return
        const changes = await engine.diff(workspace, baseline, tree, signal)
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
        // the previous turn's numbers as if they were this one's.
        this.remember(record, emptySummary(turn))
        return
      }
      const engine = await this.engine()
      if (engine === null) {
        this.remember(record, emptySummary(turn))
        return
      }
      const end = await engine.snapshot(workspace, 'end', signal)
      if (end === null) {
        this.remember(record, emptySummary(turn))
        return
      }
      this.remember(record, summarize(turn, await engine.diff(workspace, baseline, end, signal)))
    })
  }

  /**
   * Resolve once this Session has no queued snapshot work.
   *
   * The host's tool gate awaits this before dispatching a call, which is what
   * keeps the baseline ahead of the turn's first mutation.
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

  /** Forget one Session and delete everything the tracker wrote for it. */
  async disposeSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (record === undefined) return
    this.sessions.delete(sessionId)
    await record.chain
    if (record.scratch === undefined) return
    const engine = await this.engine()
    await engine?.removeScratch(record.scratch).catch(() => {})
  }

  /** Forget every Session; used on plugin disposal. */
  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)))
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
        this.logger.warn(`chat-diff-summary-legacy: session "${record.sessionId}": ${error instanceof Error ? error.message : String(error)}`)
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

  /** Locate the Session's repository once, retrying while no repository exists yet. */
  private async workspaceFor(engine: ChangeEngine, record: SessionRecord, cwd: string, signal: AbortSignal): Promise<GitWorkspace | null> {
    if (record.workspace !== undefined && record.workspace !== null) return record.workspace
    record.scratch ??= await engine.createScratch()
    const located = await engine.locate(cwd, record.scratch, signal)
    record.workspace = located
    return located
  }
}

/** Resolve the real engine, or null when this host has no usable git. */
export type EngineProvider = () => Promise<ChangeEngine | null>

/** Resolve the real git engine once, or null when this host has no usable git. */
export function createEngineProvider(runner: CommandRunner, logger: GitLogger, signal: AbortSignal): EngineProvider {
  let resolved: Promise<ChangeEngine | null> | undefined
  return () => {
    resolved ??= (async () => {
      const environment = gitEnvironment()
      const executable = await resolveGit(runner, environment, signal)
      if (executable === null) {
        logger.warn('chat-diff-summary-legacy: git is unavailable; change summaries are disabled')
        return null
      }
      return createGitEngine(runner, executable, environment)
    })()
    return resolved
  }
}
