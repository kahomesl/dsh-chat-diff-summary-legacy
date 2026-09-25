/**
 * The git plumbing behind the change tracker.
 *
 * Every write this module performs is routed into a caller-owned scratch
 * directory: the scratch object store is the *only* `GIT_OBJECT_DIRECTORY`, the
 * repository's own store is attached read-only as an alternate, and each
 * snapshot writes through its own private `GIT_INDEX_FILE`. The repository's
 * index, object store, work tree, HEAD and refs are therefore never written —
 * see `tests/git.spec.ts`, which hashes all four before and after a turn that
 * modifies, adds, deletes and renames files, and which re-runs the stat-cache
 * probe that `snapshotTree` documents.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Settled facts of one subprocess; a nonzero exit is a result, not an exception. */
export interface CommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** One subprocess run's request. */
export interface CommandRequest {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly signal: AbortSignal
}

/** Runs one program to completion; injected so the tracker can be unit-tested without git. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

/** Per-command bounds for the tracked repository's git calls. */
export const GIT_TIMEOUT_MS = 30_000
/** In-memory stdout cap for one git call. */
export const GIT_MAX_BYTES = 8 * 1024 * 1024

/**
 * Bound for the single pass that mints a synthetic workspace's first tree.
 *
 * That pass reads every accepted file once, so it is the only git call in this
 * plugin whose cost scales with the whole directory rather than with a turn:
 * measured on a 1.7 GB / 28k-file directory with the default excludes, it took
 * 36.7 s. Every later pass re-reads only what changed. The larger bound exists so
 * a big directory is allowed to finish instead of being abandoned at 30 s.
 */
export const GIT_WARMUP_TIMEOUT_MS = 10 * 60_000

/** Environment entries carried into every git call; everything else is scrubbed. */
const PASSTHROUGH = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot', 'ComSpec', 'PATHEXT', 'SystemDrive']

/** Environment entries that must never leak into a git call from the host process. */
const SCRUBBED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_NAMESPACE', 'GIT_SSH_COMMAND']

/** The repository enclosing a Session working directory, and the private store its snapshots write to. */
export interface GitWorkspace {
  /** Repository top level; the root every reported diff path is relative to. */
  readonly root: string
  /** Absolute git directory holding the repository's index. */
  readonly gitDir: string
  /** Canonical scratch directory holding the private object store and each snapshot's index. */
  readonly scratch: string
  /** Environment routing object writes to the private store and object reads through the repository's store. */
  readonly env: Readonly<Record<string, string>>
  /** Work-tree paths a snapshot must skip: the private directory, when it happens to lie inside the work tree. */
  readonly excludes: readonly string[]
  /**
   * True when this workspace was minted for a directory no repository encloses.
   *
   * A synthetic workspace carries its own private repository: `gitDir` is a
   * directory this plugin created under `scratch`, `env` points git at it, and
   * the work tree is the Session's own directory. Nothing is written inside the
   * work tree — the only trace of the workspace is `scratch`, which the Session
   * removes when it ends.
   */
  readonly synthetic?: true
}

/** One changed path between two snapshot trees. */
export interface RawChange {
  /** Post-image path, relative to the repository root. A deletion keeps its pre-image path. */
  readonly path: string
  readonly added: number
  readonly deleted: number
  readonly binary: boolean
}

/** Minimal subset of the host logger this module uses. */
export interface GitLogger {
  warn(message: string): void
  /** Optional: step costs and lifecycle notes; absent means "failures only". */
  info?(message: string): void
}

/** Per-call identity the engine carries into every diagnostic it reports. */
export interface GitCallContext {
  /** Session whose turn drove this call, when one did. */
  readonly sessionId?: string
  /** Which attempt of a synthetic workspace's first pass this call belongs to. */
  readonly attempt?: number
}

/** One step that failed, with everything needed to place it. */
export interface GitFailure extends GitCallContext {
  /** The step that failed, in git's own terms: `git init`, `add --all`, `write-tree`, … */
  readonly operation: string
  /** How long the step ran before it failed. */
  readonly elapsedMs: number
  /** Working directory or repository root the step addressed. */
  readonly root?: string
  /** Process exit code, or null when the process never started. */
  readonly exitCode?: number | null
  /** git's own words, truncated; never a path the plugin added. */
  readonly stderr?: string
  /** What the caller concluded, when the failure has no exit code. */
  readonly detail?: string
}

/** One step that finished, reported for the steps whose cost is the story. */
export interface GitStep extends GitCallContext {
  readonly operation: string
  readonly elapsedMs: number
  readonly root?: string
  readonly detail?: string
}

/** Where the engine reports what it did. */
export interface GitDiagnostics {
  failed(event: GitFailure): void
  step(event: GitStep): void
}

/** A diagnostics sink that reports nothing; the default for direct calls. */
export const SILENT_DIAGNOSTICS: GitDiagnostics = { failed: (): void => {}, step: (): void => {} }

/** Longest stderr fragment any diagnostic carries. */
const STDERR_LIMIT = 400

/** Trim one diagnostic fragment to a single bounded line. */
export function trimDiagnostic(text: string, limit = STDERR_LIMIT): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/** Render one failure as the line the host log carries. */
export function describeFailure(event: GitFailure): string {
  const parts = [`${event.operation} failed`]
  if (event.sessionId !== undefined) parts.push(`session=${event.sessionId}`)
  if (event.root !== undefined) parts.push(`root=${event.root}`)
  if (event.attempt !== undefined) parts.push(`attempt=${String(event.attempt)}`)
  if (event.exitCode !== undefined) parts.push(`exit=${String(event.exitCode)}`)
  parts.push(`elapsed=${String(event.elapsedMs)}ms`)
  if (event.detail !== undefined) parts.push(`detail=${event.detail}`)
  if (event.stderr !== undefined && event.stderr !== '') parts.push(`stderr=${trimDiagnostic(event.stderr)}`)
  return `chat-diff-summary-legacy: ${parts.join(' ')}`
}

/** Render one finished step as the line the host log carries. */
export function describeStep(event: GitStep): string {
  const parts = [`${event.operation} finished`]
  if (event.sessionId !== undefined) parts.push(`session=${event.sessionId}`)
  if (event.root !== undefined) parts.push(`root=${event.root}`)
  if (event.attempt !== undefined) parts.push(`attempt=${String(event.attempt)}`)
  parts.push(`elapsed=${String(event.elapsedMs)}ms`)
  if (event.detail !== undefined) parts.push(`detail=${event.detail}`)
  return `chat-diff-summary-legacy: ${parts.join(' ')}`
}

/** Report one failed git step, with the exit code and the words git used. */
function reportFailure(diagnostics: GitDiagnostics, context: GitCallContext, operation: string, root: string | undefined, startedAt: number, result: CommandResult | undefined, detail?: string): void {
  diagnostics.failed({
    operation,
    elapsedMs: Date.now() - startedAt,
    ...root === undefined ? {} : { root },
    ...context,
    ...result === undefined ? {} : { exitCode: result.exitCode, stderr: result.stderr },
    ...detail === undefined ? {} : { detail },
  })
}

/** Report one finished git step together with what it cost. */
function reportStep(diagnostics: GitDiagnostics, context: GitCallContext, operation: string, root: string | undefined, startedAt: number, detail?: string): void {
  diagnostics.step({
    operation,
    elapsedMs: Date.now() - startedAt,
    ...root === undefined ? {} : { root },
    ...context,
    ...detail === undefined ? {} : { detail },
  })
}

/** Report an operation that threw instead of returning an exit code. */
function reportThrown(diagnostics: GitDiagnostics, context: GitCallContext, operation: string, root: string | undefined, startedAt: number, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  const timedOut = /timed out/iu.test(detail)
  const aborted = /aborted/iu.test(detail)
  reportFailure(diagnostics, context, operation, root, startedAt, undefined, aborted ? 'aborted (workspace disposed)' : timedOut ? `warmup timeout: ${detail}` : detail)
  return detail
}

/** Run one program with a hard timeout, a stdout cap, and abort support. */
export const runCommand: CommandRunner = (request) => new Promise<CommandResult>((settle, fail) => {
  const child = spawn(request.file, [...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const out: Buffer[] = []
  const err: Buffer[] = []
  let outBytes = 0
  let done = false
  const finish = (result: CommandResult | Error): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
    if (result instanceof Error) fail(result)
    else settle(result)
  }
  const abort = (): void => {
    child.kill('SIGKILL')
    finish(new Error(`aborted: ${request.file} ${request.args.join(' ')}`))
  }
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    finish(new Error(`timed out after ${String(request.timeoutMs)}ms: ${request.file} ${request.args.join(' ')}`))
  }, request.timeoutMs)
  if (request.signal.aborted) {
    abort()
    return
  }
  request.signal.addEventListener('abort', abort, { once: true })
  child.stdout.on('data', (chunk: Buffer) => {
    outBytes += chunk.length
    // Keep the head and stop buffering past the cap: git output is consumed in
    // one shot, so an over-cap call is a failure the caller reports, not a value.
    if (outBytes <= request.maxBytes) out.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    err.push(chunk)
  })
  child.on('error', (error) => {
    finish(error)
  })
  child.on('close', (code) => {
    if (outBytes > request.maxBytes) {
      finish(new Error(`output exceeded ${String(request.maxBytes)} bytes: ${request.file} ${request.args.join(' ')}`))
      return
    }
    finish({ exitCode: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
  })
})

/** Build the scrubbed environment one git call runs under. */
export function gitEnvironment(inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of PASSTHROUGH) {
    const value = inherited[name]
    if (value !== undefined && value !== '') env[name] = value
  }
  for (const name of SCRUBBED) delete env[name]
  env.GIT_TERMINAL_PROMPT = '0'
  // Never take the optional index lock: an optional-lock refresh could otherwise
  // touch the repository's real index behind the private GIT_INDEX_FILE.
  env.GIT_OPTIONAL_LOCKS = '0'
  return env
}

/** Well-known install locations, tried after `PATH`; a GUI-launched host has a minimal `PATH`. */
const GIT_CANDIDATES = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/opt/local/bin/git', 'git']

/** Resolve one usable `git`, or null when the host has none. */
export async function resolveGit(runner: CommandRunner, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string | null> {
  // On macOS `/usr/bin/git` is a stub that opens the developer-tools installer
  // dialog instead of running when the command line tools are absent, so the
  // stub only counts as git once `xcode-select` reports a selected toolchain.
  if (process.platform === 'darwin') {
    const selected = await runner({ file: '/usr/bin/xcode-select', args: ['-p'], cwd: process.cwd(), env: { ...env, PATH: env.PATH ?? '' }, timeoutMs: 5_000, maxBytes: 4_096, signal }).catch(() => ({ exitCode: null, stdout: '', stderr: '' }))
    if (selected.exitCode !== 0) return null
  }
  for (const candidate of GIT_CANDIDATES) {
    const probe = await runner({ file: candidate, args: ['--version'], cwd: process.cwd(), env: { ...env, PATH: env.PATH ?? '' }, timeoutMs: 10_000, maxBytes: 4_096, signal }).catch(() => undefined)
    if (probe !== undefined && probe.exitCode === 0 && /^git version /u.test(probe.stdout)) return candidate
  }
  return null
}

/** Whether `child` is `parent` or lies below it, on canonical paths. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Convert an OS-relative path to the slash form git pathspecs use. */
function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Locate the repository enclosing a working directory and prepare the private
 * directory its snapshots write to.
 * @param runner - the injected subprocess runner.
 * @param executable - the resolved git executable.
 * @param env - the scrubbed environment.
 * @param cwd - absolute Session working directory.
 * @param scratch - yields the private directory; called only once a repository is found.
 * @param signal - cancellation.
 * @param diagnostics - where step costs and failures are reported.
 * @param context - the Session (and attempt) this call belongs to.
 * @returns the located repository, or null when `cwd` is outside one.
 */
export async function locateWorkspace(runner: CommandRunner, executable: string, env: Readonly<Record<string, string>>, cwd: string, scratch: () => Promise<string>, signal: AbortSignal, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<GitWorkspace | null> {
  const started = Date.now()
  const found = await runner({ file: executable, args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'], cwd, env, timeoutMs: 10_000, maxBytes: 64 * 1024, signal })
  if (found.exitCode !== 0) {
    // Asking whether a directory is inside a repository is the one probe whose
    // failure is the normal answer, so it is reported as a step, not a failure:
    // the synthetic path is what runs next.
    reportStep(diagnostics, context, 'rev-parse --show-toplevel (repository probe)', cwd, started, `exit=${String(found.exitCode)}`)
    return null
  }
  const [root, gitDir, repositoryObjects] = found.stdout.split('\n').slice(0, 3).map((line) => resolve(cwd, line))
  if (root === undefined || gitDir === undefined || repositoryObjects === undefined) {
    reportFailure(diagnostics, context, 'rev-parse --show-toplevel (repository probe)', cwd, started, found, 'the answer did not name a root, a git directory and an object store')
    return null
  }
  const objects = join(await scratch(), 'objects')
  await mkdir(objects, { recursive: true })
  // git reports the canonical top level, so the scratch is compared in the same spelling.
  const canonical = await realpath(join(objects, '..'))
  return {
    root,
    gitDir,
    scratch: canonical,
    env: { ...env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects },
    // A scratch directory that happens to lie inside the work tree — a workspace
    // under the system temporary root — must not appear in its own snapshot.
    excludes: isInside(root, canonical) ? [toPosix(relative(root, canonical))] : [],
  }
}

/**
 * Write the complete work tree — modified, deleted, untracked, but not ignored
 * files — as a tree object in the private object store.
 *
 * The private index is seeded from HEAD rather than copied from the repository's
 * index, and that distinction is load-bearing. A copied index carries the
 * repository's stat cache, and `git add` is allowed to trust a cached stat: when
 * an edit preserves a file's size and the copy's own mtime lands after the
 * file's, git skips re-hashing and writes a tree holding the *previous* content.
 * Measured on this machine, that silently produced a stale tree in 2 of 40
 * same-size edits — a turn whose change went unreported. `read-tree` populates
 * entries with no stat data, so `git add` must hash every path; the same probe
 * scored 0 of 40. `tests/git.spec.ts` keeps that probe as a regression guard.
 *
 * @param runner - the injected subprocess runner.
 * @param executable - the resolved git executable.
 * @param workspace - the addressed repository.
 * @param index - absolute path this snapshot's private index is written to.
 * @param excludes - work-tree paths the snapshot must skip.
 * @param signal - cancellation.
 * @param diagnostics - where step costs and failures are reported.
 * @param context - the Session (and attempt) this call belongs to.
 * @returns the tree object id, or null when git refused the snapshot.
 */
export async function snapshotTree(runner: CommandRunner, executable: string, workspace: GitWorkspace, index: string, excludes: readonly string[], signal: AbortSignal, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<string | null> {
  await mkdir(join(index, '..'), { recursive: true })
  // Start from no index at all, so nothing can carry a stat cache into the add.
  await rm(index, { force: true })
  const env = { ...workspace.env, GIT_INDEX_FILE: index }
  // Seed the tracked set from HEAD. A repository whose HEAD has no commit yet
  // (fresh `git init`) simply starts empty; either way no stat data survives.
  const seeded = await runner({ file: executable, args: ['read-tree', 'HEAD'], cwd: workspace.root, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, signal })
  if (seeded.exitCode !== 0) {
    // A repository with no commit yet answers this with a failure; the add below
    // starts from an empty index instead, so this is reported and not fatal.
    reportStep(diagnostics, context, 'read-tree HEAD (no commit yet)', workspace.root, Date.now(), `exit=${String(seeded.exitCode)}`)
    await rm(index, { force: true })
  }
  const pathspec = excludes.length === 0 ? [] : ['--', '.', ...excludes.map((path) => `:(exclude)${path}`)]
  // `--ignore-errors` skips unreadable files and reports them through exit 1; the index is still complete.
  const addStarted = Date.now()
  const added = await runner({ file: executable, args: ['add', '--all', '--ignore-errors', ...pathspec], cwd: workspace.root, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, signal })
  if (added.exitCode !== 0 && added.exitCode !== 1) {
    reportFailure(diagnostics, context, 'add --all', workspace.root, addStarted, added)
    return null
  }
  const written = await runner({ file: executable, args: ['write-tree'], cwd: workspace.root, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024, signal })
  if (written.exitCode !== 0) {
    reportFailure(diagnostics, context, 'write-tree', workspace.root, addStarted, written)
    return null
  }
  const tree = written.stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(tree)) {
    reportFailure(diagnostics, context, 'write-tree', workspace.root, addStarted, written, 'the answer was not a tree id')
    return null
  }
  return tree
}

/**
 * Ignore patterns a synthetic workspace starts with.
 *
 * Nothing else can supply them: the directory has no repository, so it has no
 * ignore rules written for a repository root and no store to hold them. A
 * `.gitignore` found *inside* the directory still applies, because git resolves
 * those through the private repository too; this list is added on top of it. A
 * user-level `core.excludesFile` applies only where git can find the user's own
 * configuration — on POSIX, where `HOME` survives into these calls, and not on
 * Windows, where this plugin's scrubbed environment carries no profile path.
 *
 * The set is about cost rather than taste. The first pass reads every file it
 * accepts, so it skips source-control stores, dependency trees, build output,
 * and the archives and binaries that carry no line counts to report in the first
 * place. The README lists the same patterns for readers.
 */
export const SYNTHETIC_EXCLUDES = [
  '# Source-control stores and dependency trees.',
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  '# Build output and caches.',
  'dist/',
  'build/',
  'out/',
  'target/',
  'coverage/',
  '__pycache__/',
  '.venv/',
  'venv/',
  '# Archives and binaries: no line counts, and they dominate the first pass.',
  '*.apk',
  '*.zip',
  '*.7z',
  '*.rar',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.iso',
  '*.dmg',
  '*.msi',
].join('\n') + '\n'

/**
 * Mint a private workspace for a directory that no repository encloses.
 *
 * The result is a real repository, but not one the user owns: `git init` creates
 * it inside `scratch`, every later call addresses it through `GIT_DIR` and
 * `GIT_WORK_TREE`, and the measured directory therefore gains no `.git`, no
 * index and no object store of its own. Its ignore rules come from the private
 * repository's `info/exclude`; the three configuration values below are what a
 * byte-faithful measurement needs — no line-ending translation on add
 * (`core.autocrlf`, `core.safecrlf`), and no advice line when the directory
 * happens to hold a repository of its own, which git records as an embedded
 * repository instead of walking into it.
 *
 * @param runner - the injected subprocess runner.
 * @param executable - the resolved git executable.
 * @param env - the scrubbed environment.
 * @param cwd - absolute Session working directory, outside any repository.
 * @param scratch - this Session's private directory; the repository is created inside it.
 * @param signal - cancellation.
 * @param diagnostics - where step costs and failures are reported.
 * @param context - the Session (and attempt) this call belongs to.
 * @returns the synthetic workspace, or null when git refused to create one.
 */
export async function locateSyntheticWorkspace(runner: CommandRunner, executable: string, env: Readonly<Record<string, string>>, cwd: string, scratch: string, signal: AbortSignal, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<GitWorkspace | null> {
  const started = Date.now()
  let root: string
  try {
    root = await realpath(cwd)
  } catch (error) {
    // A working directory that no longer exists cannot be measured.
    reportThrown(diagnostics, context, 'realpath (working directory)', cwd, started, error)
    return null
  }
  const repository = join(scratch, 'directory')
  // Only a directory git itself calls "not a git repository" may be measured this
  // way. Every other rev-parse failure — a corrupt `.git`, a `safe.directory`
  // refusal, a `.git` file pointing at a missing directory — stays the repository
  // path's problem: it is retried there next turn, never silently replaced by a
  // store this plugin owns. Git's own words are read in the C locale so the test
  // does not depend on the user's language.
  const outside = await runner({ file: executable, args: ['rev-parse', '--show-toplevel'], cwd: root, env: { ...env, LC_ALL: 'C' }, timeoutMs: 10_000, maxBytes: 64 * 1024, signal })
  if (outside.exitCode === 0 || !/not a git repository/u.test(outside.stderr)) {
    reportFailure(diagnostics, context, 'rev-parse --show-toplevel (synthetic probe)', root, started, outside, outside.exitCode === 0 ? 'the directory turned out to be inside a repository' : 'git answered something other than "not a git repository"')
    return null
  }
  await mkdir(repository, { recursive: true })
  const initStarted = Date.now()
  const created = await runner({ file: executable, args: ['init', '--quiet', repository], cwd: root, env, timeoutMs: 10_000, maxBytes: 64 * 1024, signal })
  if (created.exitCode !== 0) {
    reportFailure(diagnostics, context, 'git init (private repository)', root, initStarted, created)
    return null
  }
  // `git init <dir>` puts the repository in `<dir>/.git`; addressing that is what
  // makes every later call see a repository at all.
  const gitDir = join(repository, '.git')
  await mkdir(join(gitDir, 'info'), { recursive: true })
  await writeFile(join(gitDir, 'info', 'exclude'), SYNTHETIC_EXCLUDES, 'utf8')
  // Addressed by file rather than by repository discovery: `git config` refuses
  // to discover a repository from `GIT_DIR` alone when the working directory is
  // not one, and a refusal here would abandon the whole workspace.
  for (const [key, value] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['advice.addEmbeddedRepo', 'false']] as const) {
    const configStarted = Date.now()
    const configured = await runner({ file: executable, args: ['config', '--file', join(gitDir, 'config'), key, value], cwd: root, env, timeoutMs: 10_000, maxBytes: 64 * 1024, signal })
    if (configured.exitCode !== 0) {
      reportFailure(diagnostics, context, `git config ${key}`, root, configStarted, configured)
      return null
    }
  }
  reportStep(diagnostics, context, 'private repository created', root, started, `gitDir=${gitDir}`)
  return {
    root,
    gitDir,
    scratch,
    env: { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: root },
    excludes: isInside(root, scratch) ? [toPosix(relative(root, scratch))] : [],
    synthetic: true,
  }
}

/**
 * Refresh a synthetic workspace's index and return the tree it now states.
 *
 * Unlike {@link snapshotTree}, this snapshot keeps its index. The index is the
 * synthetic workspace's memory: the stat data it carries is what turns a
 * measurement into a stat walk instead of a full read — the directory that takes
 * 36.7 s to read once costs 0.13 s to re-check. That is the one place in this
 * plugin where a stat cache is trusted, and it can, on a filesystem with coarse
 * timestamps, miss an edit that preserves both a file's size and its recorded
 * timestamps. Git's own racy-timestamp rule already re-reads anything not
 * strictly older than the index, which is the case that actually happens. A
 * directory whose owner wants the repository path's forced re-read belongs in a
 * repository, where that path runs.
 *
 * @param runner - the injected subprocess runner.
 * @param executable - the resolved git executable.
 * @param workspace - the synthetic workspace.
 * @param timeoutMs - bound for the add; the first pass needs more of it than a turn does.
 * @param signal - cancellation.
 * @param diagnostics - where step costs and failures are reported.
 * @param context - the Session (and attempt) this call belongs to.
 * @returns the tree object id, or null when git refused the snapshot.
 */
export async function snapshotSyntheticTree(runner: CommandRunner, executable: string, workspace: GitWorkspace, timeoutMs: number, signal: AbortSignal, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<string | null> {
  const pathspec = workspace.excludes.length === 0 ? [] : ['--', '.', ...workspace.excludes.map((path) => `:(exclude)${path}`)]
  const first = Date.now()
  let added: CommandResult
  try {
    // `--ignore-errors` skips unreadable files and reports them through exit 1; the index is still complete.
    added = await runner({ file: executable, args: ['add', '--all', '--ignore-errors', ...pathspec], cwd: workspace.root, env: workspace.env, timeoutMs, maxBytes: GIT_MAX_BYTES, signal })
  } catch (error) {
    // A timeout or an abort throws rather than answering, and it is the failure
    // this plugin's first pass is most likely to hit on a large directory.
    reportThrown(diagnostics, context, timeoutMs > GIT_TIMEOUT_MS ? 'add --all (first pass)' : 'add --all (incremental)', workspace.root, first, error)
    return null
  }
  if (added.exitCode !== 0 && added.exitCode !== 1) {
    reportFailure(diagnostics, context, timeoutMs > GIT_TIMEOUT_MS ? 'add --all (first pass)' : 'add --all (incremental)', workspace.root, first, added, 'git refused the add')
    return null
  }
  const writeStarted = Date.now()
  let written: CommandResult
  try {
    written = await runner({ file: executable, args: ['write-tree'], cwd: workspace.root, env: workspace.env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024, signal })
  } catch (error) {
    reportThrown(diagnostics, context, 'write-tree', workspace.root, writeStarted, error)
    return null
  }
  if (written.exitCode !== 0) {
    reportFailure(diagnostics, context, 'write-tree', workspace.root, writeStarted, written)
    return null
  }
  const tree = written.stdout.trim()
  if (!/^[0-9a-f]{40,64}$/u.test(tree)) {
    reportFailure(diagnostics, context, 'write-tree', workspace.root, writeStarted, written, 'the answer was not a tree id')
    return null
  }
  reportStep(diagnostics, context, timeoutMs > GIT_TIMEOUT_MS ? 'add --all (first pass)' : 'add --all (incremental)', workspace.root, first, `tree=${tree.slice(0, 12)}`)
  return tree
}

/**
 * Per-file counts between two snapshot trees of a synthetic workspace.
 *
 * Same measurement as {@link diffTrees}, with one correction that only a
 * synthetic workspace needs. A directory inside the measured tree that holds a
 * repository of its own is recorded by git as an embedded repository — a
 * gitlink, not a directory of files — and `--numstat` then reports the pointer
 * it moved as one added and one deleted line. Nobody changed a line. An entry
 * like that is re-reported as a binary file, which the bar draws as a name
 * without counts, and the README says so.
 *
 * @param runner - the injected subprocess runner.
 * @param executable - the resolved git executable.
 * @param workspace - the addressed synthetic workspace.
 * @param before - turn-start tree id.
 * @param after - turn-end tree id.
 * @param signal - cancellation.
 * @param diagnostics - where step costs and failures are reported.
 * @param context - the Session (and attempt) this call belongs to.
 * @returns changed files relative to the Session working directory.
 * @throws when git fails or the output exceeded the cap.
 */
export async function diffSyntheticTrees(runner: CommandRunner, executable: string, workspace: GitWorkspace, before: string, after: string, signal: AbortSignal, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<RawChange[]> {
  const changes = await diffTrees(runner, executable, workspace, before, after, signal, diagnostics, context)
  if (changes.length === 0) return changes
  const listed = await runner({
    file: executable,
    args: ['ls-files', '-s', '-z', '--', ...changes.map((change) => change.path)],
    cwd: workspace.root,
    // A changed path is a path, not a pattern: `*` and `[` are ordinary bytes here.
    env: { ...workspace.env, GIT_LITERAL_PATHSPECS: '1' },
    timeoutMs: GIT_TIMEOUT_MS,
    maxBytes: GIT_MAX_BYTES,
    signal,
  })
  if (listed.exitCode !== 0) {
    reportFailure(diagnostics, context, 'ls-files (embedded repositories)', workspace.root, Date.now(), listed)
    return changes
  }
  const embedded = new Set<string>()
  for (const record of listed.stdout.split('\0')) {
    // "<mode> <object> <stage>\t<path>"; mode 160000 is an embedded repository.
    const tab = record.indexOf('\t')
    if (tab >= 0 && record.slice(0, tab).startsWith('160000 ')) embedded.add(record.slice(tab + 1))
  }
  if (embedded.size === 0) return changes
  return changes.map((change) => (embedded.has(change.path) ? { path: change.path, added: 0, deleted: 0, binary: true } : change))
}

/**
 * Parse the NUL-terminated records of `git diff-tree -r -M -z --numstat`. A
 * rename record carries an empty path followed by the old and the new path.
 * @param output - the complete stdout of that call.
 * @returns records in git's output order.
 * @throws when a record is malformed, which means the output was truncated.
 */
export function parseNumstat(output: string): RawChange[] {
  const queue = output.split('\0')
  if (queue.at(-1) !== '') throw new Error('numstat output is not NUL-terminated')
  queue.pop()
  const changes: RawChange[] = []
  while (queue.length > 0) {
    const record = queue.shift() ?? ''
    // Only the first two tabs separate fields; a file name keeps its own tabs.
    const first = record.indexOf('\t')
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1)
    if (second < 0) throw new Error(`malformed numstat record: ${JSON.stringify(record)}`)
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    let path = record.slice(second + 1)
    if (path === '') {
      // A rename: the pre-image is dropped and the post-image names the record.
      queue.shift()
      const renamed = queue.shift()
      if (renamed === undefined) throw new Error('malformed numstat rename record')
      path = renamed
    }
    const binary = added === '-'
    changes.push({
      path,
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    })
  }
  return changes
}

/**
 * Per-file line counts between two snapshot trees, with renames detected.
 * @param runner - the injected subprocess runner.
 * @param executable - the resolved git executable.
 * @param workspace - the addressed repository.
 * @param before - turn-start tree id.
 * @param after - turn-end tree id.
 * @param signal - cancellation.
 * @param diagnostics - where step costs and failures are reported.
 * @param context - the Session (and attempt) this call belongs to.
 * @returns changed files relative to the repository root.
 * @throws when git fails or the output exceeded the cap.
 */
export async function diffTrees(runner: CommandRunner, executable: string, workspace: GitWorkspace, before: string, after: string, signal: AbortSignal, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<RawChange[]> {
  if (before === after) return []
  const started = Date.now()
  const result = await runner({ file: executable, args: ['diff-tree', '-r', '-M', '-z', '--numstat', before, after], cwd: workspace.root, env: workspace.env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, signal })
  if (result.exitCode !== 0) {
    reportFailure(diagnostics, context, 'diff-tree', workspace.root, started, result)
    throw new Error(`git diff-tree failed: ${result.stderr.trim()}`)
  }
  return parseNumstat(result.stdout)
}

/** Marker file every scratch directory of this plugin starts with. */
export const SCRATCH_MARKER_FILE = '.dsh-chat-diff-legacy-scratch.json'

/**
 * What a scratch directory says about itself.
 *
 * The marker is what makes cleanup safe: a directory is only ever removed when
 * this file names this plugin. Name matching alone is not enough — another
 * program's temporary directory may share the prefix, and deleting by prefix
 * would be a data-loss bug, not a cleanup.
 */
export interface ScratchMarker {
  /** Bumped when this shape changes; an unknown schema is never removed. */
  readonly schema: 1
  /** Owning plugin, matched exactly before anything is deleted. */
  readonly plugin: string
  /** What the directory holds. */
  readonly kind: 'repository' | 'synthetic'
  /** Working directory the snapshots measure. */
  readonly root?: string
  /** Host process that created it, for a reader's benefit only. */
  readonly pid: number
  readonly createdAt: string
}

/** Create one private scratch directory outside the work tree, canonicalized, and mark it. */
export async function createScratch(label: string, marker: ScratchMarker): Promise<string> {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), `${label}-`)))
  await writeFile(join(scratch, SCRATCH_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  return scratch
}

/** Remove one private scratch directory and everything git wrote into it. */
export async function removeScratch(scratch: string, diagnostics: GitDiagnostics = SILENT_DIAGNOSTICS, context: GitCallContext = {}): Promise<void> {
  const started = Date.now()
  try {
    await rm(scratch, { recursive: true, force: true })
  } catch (error) {
    // Windows refuses to delete a directory a git process still holds open; the
    // caller must know, because a half-removed scratch is what the startup sweep
    // exists to collect.
    reportThrown(diagnostics, context, 'remove scratch directory', scratch, started, error)
  }
}

/** What one startup sweep did. */
export interface ScratchGcResult {
  /** Directories this sweep removed. */
  readonly removed: readonly string[]
  /** Directories it recognised as this plugin's but left alone: too fresh, or in use. */
  readonly kept: readonly string[]
  /** Directories carrying the prefix but not this plugin's marker; never touched. */
  readonly unrecognised: readonly string[]
}

/** How old a scratch directory must be before a sweep may remove it. */
export const SCRATCH_ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000

/** Most candidates one startup sweep will inspect, so a huge temp root cannot stall boot. */
const SCRATCH_GC_LIMIT = 200

/**
 * Remove scratch directories this plugin left behind when a host died.
 *
 * A plugin teardown removes every scratch it owns; only a crash, a kill or a
 * failed removal can leave one. This sweep is the answer to those, and it is
 * deliberately conservative: the directory name must carry the plugin's prefix,
 * the marker file must exist and name this plugin with a known schema, and the
 * directory must not have been written to for {@link SCRATCH_ORPHAN_MIN_AGE_MS}.
 * A live host writes into its scratch on every turn, so an in-use directory is
 * never old enough to qualify, and a foreign directory is never touched at all.
 *
 * @param options - the prefix, the owner name, and the bounds.
 * @returns what the sweep removed, kept and refused to recognise.
 */
export async function collectOrphanScratches(options: { label: string; plugin: string; minAgeMs?: number; now?: number; root?: string; diagnostics?: GitDiagnostics }): Promise<ScratchGcResult> {
  const prefix = `${options.label}-`
  const minAgeMs = options.minAgeMs ?? SCRATCH_ORPHAN_MIN_AGE_MS
  const now = options.now ?? Date.now()
  const root = options.root ?? tmpdir()
  const diagnostics = options.diagnostics ?? SILENT_DIAGNOSTICS
  const removed: string[] = []
  const kept: string[] = []
  const unrecognised: string[] = []
  let candidates: string[]
  try {
    candidates = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => join(root, entry.name))
      .slice(0, SCRATCH_GC_LIMIT)
  } catch (error) {
    reportThrown(diagnostics, {}, 'read the temporary root', root, Date.now(), error)
    return { removed, kept, unrecognised }
  }
  for (const candidate of candidates) {
    let marker: ScratchMarker
    try {
      marker = JSON.parse(await readFile(join(candidate, SCRATCH_MARKER_FILE), 'utf8')) as ScratchMarker
    } catch {
      // No marker, or one this plugin cannot read: not ours to delete.
      unrecognised.push(candidate)
      continue
    }
    if (marker.plugin !== options.plugin || marker.schema !== 1) {
      unrecognised.push(candidate)
      continue
    }
    let age: number
    try {
      age = now - (await stat(candidate)).mtimeMs
    } catch {
      unrecognised.push(candidate)
      continue
    }
    if (age < minAgeMs) {
      kept.push(candidate)
      continue
    }
    const started = Date.now()
    try {
      await rm(candidate, { recursive: true, force: true })
      removed.push(candidate)
      reportStep(diagnostics, {}, 'removed an orphaned scratch directory', candidate, started, `kind=${marker.kind} ageMs=${String(Math.round(age))}`)
    } catch (error) {
      reportThrown(diagnostics, {}, 'remove an orphaned scratch directory', candidate, started, error)
    }
  }
  return { removed, kept, unrecognised }
}
