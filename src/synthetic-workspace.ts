/**
 * The shared synthetic workspaces: one private repository per canonical working
 * directory, shared by every Session that works in it.
 *
 * A synthetic workspace exists because a directory no repository encloses still
 * has to be measured, and measuring it means minting a private repository and
 * reading the whole directory once. That first pass is the only operation in
 * this plugin whose cost scales with the directory rather than with a turn, and
 * it is why this module exists: a workspace is addressed by `realpath(cwd)` and
 * reused, so opening a second Session in the same directory costs one stat walk
 * rather than another whole-directory pass and another multi-hundred-megabyte
 * object store.
 *
 * Everything a Session keeps for itself — its turn, its baseline tree id, its
 * summaries, whether a measurement is in flight — stays in the tracker. What is
 * shared here is only what is expensive and identical for every consumer:
 *
 *     canonical cwd ─► SharedWorkspace ─┬─ Session A (turn, baseline, summaries)
 *                                        ├─ Session B
 *                                        └─ Session C
 *
 * The first pass runs at most once at a time per workspace. Its outcome is kept
 * as `state`, and a pass that fails is retried on a later turn behind an
 * exponential backoff instead of being remembered as permanent: one transient
 * git, I/O or timeout failure must not cost a Session its change statistics for
 * the rest of its life.
 *
 * A workspace whose last consumer leaves is retired after {@link SCRATCH_IDLE_MS}
 * of idleness — long enough that closing one Session and opening the next reuses
 * the pass, short enough that its object store does not linger. Plugin disposal
 * retires every workspace at once, and `collectOrphanScratches` in `git.ts`
 * sweeps what a crashed host left behind.
 */
import { realpath } from 'node:fs/promises'
import type { GitCallContext, GitDiagnostics, GitLogger, GitWorkspace, ScratchMarker } from './git.ts'
import { SILENT_DIAGNOSTICS } from './git.ts'

/** The subset of the snapshot engine this registry drives; the tracker owns the rest. */
export interface WorkspaceEngine {
  /** Mint a private repository for a directory no repository encloses, or null when git refused. */
  locateDirectory(cwd: string, scratch: string, signal: AbortSignal, context?: GitCallContext): Promise<GitWorkspace | null>
  /** Refresh a synthetic workspace's own index; `warm` selects the first, whole-directory bound. */
  snapshotDirectory(workspace: GitWorkspace, warm: boolean, signal: AbortSignal, context?: GitCallContext): Promise<string | null>
  /** Create one private scratch directory, marked as this plugin's own. */
  createScratch(kind: ScratchMarker['kind'], root: string | undefined): Promise<string>
  /** Remove one private scratch directory. */
  removeScratch(scratch: string, context?: GitCallContext): Promise<void>
}

/** How far a synthetic workspace's first, whole-directory pass has got. */
export type WarmState = 'cold' | 'warming' | 'ready' | 'failed'

/** One shared synthetic workspace and everything known about it. */
export interface SharedWorkspace {
  /** Canonical key: `realpath(cwd)`, case-folded on Windows. */
  readonly key: string
  /** Canonical working directory this workspace measures. */
  readonly root: string
  /** The private directory holding the repository, its objects and its index. */
  readonly scratch: string
  /** The synthetic repository, once a pass has minted it. */
  workspace: GitWorkspace | null
  /** How far the first pass has got. */
  state: WarmState
  /** Passes started so far, which is also what the backoff is computed from. */
  attempts: number
  /** The pass in flight, or the last one that ran; every consumer awaits this same promise. */
  warm: Promise<boolean> | undefined
  /** Earliest time the next pass may start, after a failure. */
  retryAt: number
  /** Sessions currently holding this workspace. */
  readonly consumers: Set<string>
  /** When the last consumer last touched it. */
  lastUsed: number
  /** Pending retirement, cancelled when a consumer claims the workspace again. */
  retireTimer: ReturnType<typeof setTimeout> | undefined
  /** What the last failure said, so a later attempt can name it. */
  lastFailure: string | undefined
  /** The engine that created it, which is the one that can remove it. */
  engine: WorkspaceEngine | undefined
}

/** What one Session gets back from {@link SyntheticWorkspaces.prepare}. */
export interface PreparedWorkspace {
  /** The shared entry, to be handed back to {@link SyntheticWorkspaces.release}. */
  readonly entry: SharedWorkspace | undefined
  /** The repository, or null when it could not be minted (yet). */
  readonly workspace: GitWorkspace | null
  /** Whether the first pass has finished, so this turn can be measured. */
  readonly ready: boolean
}

/** Tuning knobs; the defaults are what the plugin runs with. */
export interface SyntheticWorkspaceOptions {
  /** How long a workspace with no consumers is kept before its scratch is removed. */
  readonly idleMs?: number
  /** First backoff after a failed pass. */
  readonly backoffBaseMs?: number
  /** Ceiling for that backoff, however many attempts fail. */
  readonly backoffMaxMs?: number
  /** Injectable clock, so a spec can drive the backoff without waiting. */
  readonly now?: () => number
  /** Where step costs and failures are reported. */
  readonly diagnostics?: GitDiagnostics
}

/** How long a workspace with no consumers is kept before its scratch is removed. */
export const SCRATCH_IDLE_MS = 5 * 60_000

/** First backoff after a failed first pass; doubles per attempt up to the ceiling. */
export const WARMUP_BACKOFF_BASE_MS = 1_000

/** Ceiling for the retry backoff: a permanently unreadable directory is retried, but rarely. */
export const WARMUP_BACKOFF_MAX_MS = 5 * 60_000

/**
 * How long a turn's tool gate waits for a cold first pass.
 *
 * Accuracy is the priority: the gate waits so the turn's baseline is written
 * before its first mutating tool, which is what makes a cold turn measurable at
 * all. The bound is what keeps a pathological directory from holding every tool
 * call: past it, the pass keeps running in the background, this turn is logged
 * as unmeasured, and the next turn inherits the finished pass.
 */
export const WARMUP_GATE_BUDGET_MS = 120_000

/** Canonical, comparable key for one working directory. */
export async function workspaceKey(cwd: string): Promise<string> {
  const canonical = await realpath(cwd)
  // Windows paths are case-insensitive and may differ in drive-letter case; two
  // Sessions in the same directory must land on the same entry.
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** The canonical directory a key stands for, spelled the way the filesystem does. */
export async function workspaceRoot(cwd: string): Promise<{ key: string; canonical: string }> {
  const canonical = await realpath(cwd)
  return { key: process.platform === 'win32' ? canonical.toLowerCase() : canonical, canonical }
}

/** The registry of shared synthetic workspaces. */
export class SyntheticWorkspaces {
  private readonly entries = new Map<string, SharedWorkspace>()
  private readonly claimed = new Map<string, string>()
  private disposed = false

  constructor(
    private readonly logger: GitLogger,
    private readonly lifetime: AbortSignal,
    private readonly options: SyntheticWorkspaceOptions = {},
  ) {}

  /** The clock the backoff is measured against. */
  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** The diagnostics sink, with `info` routed to the logger when it has one. */
  private get diagnostics(): GitDiagnostics {
    return this.options.diagnostics ?? SILENT_DIAGNOSTICS
  }

  /** Every entry currently held, for diagnostics and specs. */
  entriesHeld(): readonly SharedWorkspace[] {
    return [...this.entries.values()]
  }

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
  async prepare(sessionId: string, cwd: string, engine: WorkspaceEngine, signal: AbortSignal, budgetMs: number): Promise<PreparedWorkspace> {
    if (this.disposed) return { entry: undefined, workspace: null, ready: false }
    let key: string
    let canonical: string
    try {
      ;({ key, canonical } = await workspaceRoot(cwd))
    } catch (error) {
      this.diagnostics.failed({ operation: 'realpath (workspace key)', root: cwd, elapsedMs: 0, sessionId, detail: error instanceof Error ? error.message : String(error) })
      return { entry: undefined, workspace: null, ready: false }
    }
    const previous = this.claimed.get(sessionId)
    if (previous !== undefined && previous !== key) await this.release(sessionId)
    let entry = this.entries.get(key)
    if (entry === undefined) {
      let scratch: string
      try {
        scratch = await engine.createScratch('synthetic', key)
      } catch (error) {
        this.diagnostics.failed({ operation: 'create scratch directory', root: key, elapsedMs: 0, sessionId, detail: error instanceof Error ? error.message : String(error) })
        return { entry: undefined, workspace: null, ready: false }
      }
      entry = {
        key,
        root: canonical,
        scratch,
        workspace: null,
        state: 'cold',
        attempts: 0,
        warm: undefined,
        retryAt: 0,
        consumers: new Set(),
        lastUsed: this.now,
        retireTimer: undefined,
        lastFailure: undefined,
        engine,
      }
      this.entries.set(key, entry)
      this.diagnostics.step({ operation: 'shared workspace opened', root: key, elapsedMs: 0, sessionId, detail: `scratch=${scratch}` })
    }
    // A workspace that was waiting to be retired is claimed again instead.
    if (entry.retireTimer !== undefined) {
      clearTimeout(entry.retireTimer)
      entry.retireTimer = undefined
    }
    entry.consumers.add(sessionId)
    entry.lastUsed = this.now
    this.claimed.set(sessionId, key)
    const ready = await this.ready(entry, engine, signal, budgetMs)
    return { entry, workspace: entry.workspace, ready }
  }

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
  async ready(entry: SharedWorkspace, engine: WorkspaceEngine, signal: AbortSignal, budgetMs: number): Promise<boolean> {
    entry.lastUsed = this.now
    if (this.stateOf(entry) === 'ready') return true
    if (this.stateOf(entry) === 'warming' && entry.warm !== undefined) {
      await this.withinBudget(entry.warm, budgetMs)
      return this.stateOf(entry) === 'ready'
    }
    const now = this.now
    if (this.stateOf(entry) === 'failed' && now < entry.retryAt) {
      this.info(`first pass is backing off for ${String(entry.retryAt - now)}ms after ${String(entry.attempts)} failed attempt(s)${entry.lastFailure === undefined ? '' : `: ${entry.lastFailure}`}`)
      return false
    }
    const attempt = entry.attempts + 1
    entry.attempts = attempt
    entry.state = 'warming'
    entry.warm = this.runPass(entry, engine, signal, attempt)
    await this.withinBudget(entry.warm, budgetMs)
    return this.stateOf(entry) === 'ready'
  }

  /** The entry's warm state, read through a call so a caller's narrowing cannot mask a pass landing. */
  private stateOf(entry: SharedWorkspace): WarmState {
    return entry.state
  }

  /**
   * Run one first pass and settle the entry's state when it lands.
   *
   * The pass is never cancelled by a caller's budget: it is the expensive work
   * every later turn depends on, so it runs to its own git timeout and reports
   * its outcome to whoever is still holding the workspace.
   */
  private runPass(entry: SharedWorkspace, engine: WorkspaceEngine, signal: AbortSignal, attempt: number): Promise<boolean> {
    const started = this.now
    const first = [...entry.consumers][0]
    const context: GitCallContext = first === undefined ? { attempt } : { sessionId: first, attempt }
    const pass = (async (): Promise<boolean> => {
      if (this.lifetime.aborted) {
        // Plugin disposal is not a failure to retry: nothing will ask again.
        entry.state = 'failed'
        entry.lastFailure = 'aborted (plugin disposed)'
        return false
      }
      try {
        const workspace = entry.workspace ?? (await engine.locateDirectory(entry.root, entry.scratch, signal, context))
        if (workspace === null) {
          this.fail(entry, 'private repository', 'git could not address the directory', started, context, attempt)
          return false
        }
        entry.workspace = workspace
        const tree = await engine.snapshotDirectory(workspace, true, signal, context)
        if (tree === null) {
          this.fail(entry, 'first pass over the directory', 'git refused the snapshot', started, context, attempt)
          return false
        }
        entry.state = 'ready'
        entry.lastFailure = undefined
        entry.retryAt = 0
        this.diagnostics.step({ operation: 'first pass over the directory', root: entry.root, elapsedMs: this.now - started, attempt, detail: `tree=${tree.slice(0, 12)}` })
        return true
      } catch (error) {
        const detail = signal.aborted ? 'aborted (workspace or plugin disposed)' : error instanceof Error ? error.message : String(error)
        this.fail(entry, 'first pass over the directory', detail, started, context, attempt)
        return false
      }
    })()
    void pass.then((landed) => {
      // Only the attempt that is still the entry's current pass may settle it: a
      // retired-and-reopened workspace has a fresh entry with its own pass.
      if (entry.warm !== pass) return
      if (!landed) {
        entry.retryAt = this.now + this.backoff(attempt)
        this.info(`first pass failed; the next attempt for this directory may start in ${String(this.backoff(attempt))}ms`)
      }
      this.diagnostics.step({ operation: 'first pass settled', root: entry.root, elapsedMs: this.now - started, attempt, detail: `state=${entry.state}` })
    })
    return pass
  }

  /** Record one failed pass and put the entry back into a retryable state. */
  private fail(entry: SharedWorkspace, operation: string, detail: string, startedAt: number, context: GitCallContext, attempt: number): void {
    entry.state = 'failed'
    entry.lastFailure = detail
    this.diagnostics.failed({ operation, root: entry.root, elapsedMs: this.now - startedAt, ...context, attempt, detail })
  }

  /** Exponential backoff, capped; never zero, so a failing pass cannot spin. */
  private backoff(attempt: number): number {
    const base = this.options.backoffBaseMs ?? WARMUP_BACKOFF_BASE_MS
    const max = this.options.backoffMaxMs ?? WARMUP_BACKOFF_MAX_MS
    const grown = base * 2 ** Math.max(0, attempt - 1)
    return Math.min(Number.isFinite(grown) ? grown : max, max)
  }

  /** Wait for `work`, but no longer than `budgetMs`; an unbounded budget waits it out. */
  private async withinBudget(work: Promise<unknown>, budgetMs: number): Promise<void> {
    if (!Number.isFinite(budgetMs)) {
      await work
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, budgetMs))
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Let one Session stop holding its workspace; the last one out starts the idle clock. */
  async release(sessionId: string): Promise<void> {
    const key = this.claimed.get(sessionId)
    if (key === undefined) return
    this.claimed.delete(sessionId)
    const entry = this.entries.get(key)
    if (entry === undefined) return
    entry.consumers.delete(sessionId)
    entry.lastUsed = this.now
    if (entry.consumers.size > 0) return
    const idleMs = this.options.idleMs ?? SCRATCH_IDLE_MS
    if (idleMs <= 0) {
      await this.retire(entry)
      return
    }
    entry.retireTimer = setTimeout(() => {
      entry.retireTimer = undefined
      void this.retire(entry)
    }, idleMs)
    entry.retireTimer.unref?.()
  }

  /** Remove one unclaimed workspace: wait for its pass, then delete its scratch. */
  private async retire(entry: SharedWorkspace): Promise<void> {
    if (entry.consumers.size > 0) return
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    if (entry.retireTimer !== undefined) {
      clearTimeout(entry.retireTimer)
      entry.retireTimer = undefined
    }
    // A pass still running would otherwise write into a directory being deleted.
    // Plugin disposal aborts the lifetime first, which is what bounds this wait.
    if (entry.warm !== undefined) await entry.warm.catch(() => false)
    const last = [...entry.consumers][0]
    await entry.engine?.removeScratch(entry.scratch, last === undefined ? {} : { sessionId: last }).catch(() => {})
    this.diagnostics.step({ operation: 'shared workspace retired', root: entry.root, elapsedMs: 0, detail: `scratch=${entry.scratch}` })
  }

  /** Retire every workspace at once; used on plugin disposal. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    const entries = [...this.entries.values()]
    for (const entry of entries) {
      if (entry.retireTimer !== undefined) {
        clearTimeout(entry.retireTimer)
        entry.retireTimer = undefined
      }
      entry.consumers.clear()
    }
    await Promise.all(entries.map((entry) => this.retire(entry)))
  }

  /** Log one lifecycle note when the host logger carries `info`. */
  private info(message: string): void {
    this.logger.info?.(`chat-diff-summary-legacy: ${message}`)
  }
}
