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
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
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
 * @returns the located repository, or null when `cwd` is outside one.
 */
export async function locateWorkspace(runner: CommandRunner, executable: string, env: Readonly<Record<string, string>>, cwd: string, scratch: () => Promise<string>, signal: AbortSignal): Promise<GitWorkspace | null> {
  const found = await runner({ file: executable, args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'objects'], cwd, env, timeoutMs: 10_000, maxBytes: 64 * 1024, signal })
  if (found.exitCode !== 0) return null
  const [root, gitDir, repositoryObjects] = found.stdout.split('\n').slice(0, 3).map((line) => resolve(cwd, line))
  if (root === undefined || gitDir === undefined || repositoryObjects === undefined) return null
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
 * @returns the tree object id, or null when git refused the snapshot.
 */
export async function snapshotTree(runner: CommandRunner, executable: string, workspace: GitWorkspace, index: string, excludes: readonly string[], signal: AbortSignal): Promise<string | null> {
  await mkdir(join(index, '..'), { recursive: true })
  // Start from no index at all, so nothing can carry a stat cache into the add.
  await rm(index, { force: true })
  const env = { ...workspace.env, GIT_INDEX_FILE: index }
  // Seed the tracked set from HEAD. A repository whose HEAD has no commit yet
  // (fresh `git init`) simply starts empty; either way no stat data survives.
  const seeded = await runner({ file: executable, args: ['read-tree', 'HEAD'], cwd: workspace.root, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, signal })
  if (seeded.exitCode !== 0) await rm(index, { force: true })
  const pathspec = excludes.length === 0 ? [] : ['--', '.', ...excludes.map((path) => `:(exclude)${path}`)]
  // `--ignore-errors` skips unreadable files and reports them through exit 1; the index is still complete.
  const added = await runner({ file: executable, args: ['add', '--all', '--ignore-errors', ...pathspec], cwd: workspace.root, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, signal })
  if (added.exitCode !== 0 && added.exitCode !== 1) return null
  const written = await runner({ file: executable, args: ['write-tree'], cwd: workspace.root, env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024, signal })
  if (written.exitCode !== 0) return null
  const tree = written.stdout.trim()
  return /^[0-9a-f]{40,64}$/u.test(tree) ? tree : null
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
 * @returns changed files relative to the repository root.
 * @throws when git fails or the output exceeded the cap.
 */
export async function diffTrees(runner: CommandRunner, executable: string, workspace: GitWorkspace, before: string, after: string, signal: AbortSignal): Promise<RawChange[]> {
  if (before === after) return []
  const result = await runner({ file: executable, args: ['diff-tree', '-r', '-M', '-z', '--numstat', before, after], cwd: workspace.root, env: workspace.env, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES, signal })
  if (result.exitCode !== 0) throw new Error(`git diff-tree failed: ${result.stderr.trim()}`)
  return parseNumstat(result.stdout)
}

/** Create one private scratch directory outside the work tree, canonicalized. */
export async function createScratch(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `${label}-`)))
}

/** Remove one private scratch directory and everything git wrote into it. */
export async function removeScratch(scratch: string): Promise<void> {
  await rm(scratch, { recursive: true, force: true })
}
