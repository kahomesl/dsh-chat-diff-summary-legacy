// @vitest-environment node
/**
 * The git plumbing, against real repositories.
 *
 * Two things are being proved here and nothing weaker will do. First, that the
 * diff a turn produces describes *this turn* — a file the user had already
 * staged or left dirty before the turn began must not appear. Second, that the
 * snapshots leave the repository exactly as they found it: index bytes, HEAD,
 * refs, and the object store are all hashed around every snapshot below.
 */
import { describe, expect, test } from 'vitest'
import { readFile, mkdir, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  GIT_TIMEOUT_MS,
  collectOrphanScratches,
  createScratch,
  diffSyntheticTrees,
  diffTrees,
  gitEnvironment,
  locateSyntheticWorkspace,
  locateWorkspace,
  parseNumstat,
  removeScratch,
  resolveGit,
  runCommand,
  snapshotSyntheticTree,
  snapshotTree,
} from '../src/git.ts'
import type { CommandRunner, GitDiagnostics, GitFailure, GitWorkspace } from '../src/git.ts'
import { cleanup, commitAll, fileDigest, git, makeDir, makeRepo, makeScratch, treeDigest, write } from './support/repo.ts'

/**
 * Repository *metadata* the snapshots must not disturb. The work tree itself is
 * deliberately excluded: a turn is supposed to change that.
 */
async function fingerprint(repo: string): Promise<Record<string, string>> {
  return {
    index: await fileDigest(join(repo, '.git', 'index')),
    head: await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => 'unborn'),
    refs: await git(repo, ['for-each-ref']),
    objects: await treeDigest(join(repo, '.git', 'objects')),
  }
}

/** The status lines a user's pre-turn state produced. */
async function statusLines(repo: string): Promise<string[]> {
  const status = await git(repo, ['status', '--porcelain'])
  return status === '' ? [] : status.split('\n')
}

/** Whether every line of `before` still appears in `after`. */
function preserves(before: readonly string[], after: readonly string[]): boolean {
  return before.every((line) => after.includes(line))
}

/** Resolve the real git executable once for the whole suite. */
const executable = await resolveGit(runCommand, gitEnvironment(), new AbortController().signal)
if (executable === null) throw new Error('these specs require a working git')

const environment = gitEnvironment()

describe('parseNumstat', () => {
  test('reads added, deleted and path from one record', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\0')).toEqual([{ path: 'src/a.ts', added: 3, deleted: 1, binary: false }])
  })

  test('reads a rename record as its post-image path', () => {
    expect(parseNumstat('0\t0\t\0old.ts\0new.ts\0')).toEqual([{ path: 'new.ts', added: 0, deleted: 0, binary: false }])
  })

  test('keeps a tab inside a file name in the path', () => {
    expect(parseNumstat('1\t0\twe\tird.ts\0')).toEqual([{ path: 'we\tird.ts', added: 1, deleted: 0, binary: false }])
  })

  test('counts a binary record as a file without inventing line counts', () => {
    expect(parseNumstat('-\t-\tlogo.png\0')).toEqual([{ path: 'logo.png', added: 0, deleted: 0, binary: true }])
  })

  test('reads an empty output as no changes', () => {
    expect(parseNumstat('')).toEqual([])
  })

  test('rejects output that is not NUL-terminated rather than guessing', () => {
    expect(() => parseNumstat('1\t0\ta.ts')).toThrow(/NUL-terminated/u)
  })
})

describe('resolving git', () => {
  test('finds a usable git on this host', () => {
    expect(executable).not.toBeNull()
  })
})

describe('locating a workspace', () => {
  test('refuses a directory outside any repository', async () => {
    const plain = await makeDir('dsh-plain')
    const scratch = await makeScratch()
    try {
      await expect(locateWorkspace(runCommand, executable, environment, plain, () => Promise.resolve(scratch), new AbortController().signal)).resolves.toBeNull()
    } finally {
      await cleanup(plain, scratch)
    }
  })

  test('resolves the repository root from a nested working directory', async () => {
    const repo = await makeRepo('dsh-nested')
    const scratch = await makeScratch()
    try {
      await write(repo, 'a/b/c.txt', 'x\n')
      await commitAll(repo, 'init')
      const nested = join(repo, 'a', 'b')
      const located = await locateWorkspace(runCommand, executable, environment, nested, () => Promise.resolve(scratch), new AbortController().signal)
      // git reports the top level with forward slashes on every platform, so the
      // two spellings are compared as one path rather than as two strings.
      expect(located?.root.replace(/\\/gu, '/')).toBe((await git(repo, ['rev-parse', '--show-toplevel'])).replace(/\\/gu, '/'))
    } finally {
      await cleanup(repo, scratch)
    }
  })
})

describe('snapshotting a working tree', () => {
  test('does not count what was already dirty when the turn began', async () => {
    const repo = await makeRepo('dsh-baseline')
    const scratch = await makeScratch()
    try {
      await write(repo, 'A.txt', 'a\nb\nc\n')
      await write(repo, 'B.txt', 'x\n')
      await write(repo, 'C.txt', 'e\nf\n')
      await write(repo, 'E.txt', 'gone\n')
      await write(repo, 'G.txt', 'rename me\n')
      await write(repo, '.gitignore', 'ignored.txt\n')
      await commitAll(repo, 'init')

      // The user's own pre-turn state: B is staged dirty, C is unstaged dirty.
      await write(repo, 'B.txt', 'x\ny\n')
      await git(repo, ['add', 'B.txt'])
      await write(repo, 'C.txt', 'e\nf\ng\n')

      const before = await fingerprint(repo)
      const statusBefore = await statusLines(repo)
      const workspace = await locateWorkspace(runCommand, executable, environment, repo, () => Promise.resolve(scratch), new AbortController().signal)
      expect(workspace).not.toBeNull()
      const signal = new AbortController().signal
      const baseline = await snapshotTree(runCommand, executable, workspace!, join(scratch, 'index-base'), workspace!.excludes, signal)
      expect(baseline).not.toBeNull()

      // ---- the turn: a shell edit, a new file, a deletion, a binary, a rename ----
      await write(repo, 'A.txt', 'a\nB2\nc\nd\n')
      await write(repo, 'D.txt', 'new\nfile\n')
      // A deletion and a rename made the way a script or `sed -i` makes them:
      // straight through the filesystem, with the real index left alone. Node's
      // own calls are used rather than a shell, so the spec makes the same edit
      // on every platform.
      await rm(join(repo, 'E.txt'), { force: true })
      await rename(join(repo, 'G.txt'), join(repo, 'H.txt'))
      await write(repo, 'Bin.dat', 'zzz\u0000\u0001\u0002')
      // And an ignored file, which must never be counted.
      await write(repo, 'ignored.txt', 'not tracked\n')

      const end = await snapshotTree(runCommand, executable, workspace!, join(scratch, 'index-end'), workspace!.excludes, signal)
      expect(end).not.toBeNull()
      const changes = await diffTrees(runCommand, executable, workspace!, baseline!, end!, signal)
      const byPath = Object.fromEntries(changes.map((change) => [change.path, change]))

      // This turn's changes, and only this turn's.
      expect(Object.keys(byPath).sort()).toEqual(['A.txt', 'Bin.dat', 'D.txt', 'E.txt', 'H.txt'])
      expect(byPath['A.txt']).toMatchObject({ added: 2, deleted: 1 })
      expect(byPath['D.txt']).toMatchObject({ added: 2, deleted: 0 })
      expect(byPath['E.txt']).toMatchObject({ added: 0, deleted: 1 })
      expect(byPath['H.txt']).toMatchObject({ added: 0, deleted: 0 })
      // A binary file is a changed file with no invented line counts.
      expect(byPath['Bin.dat']).toMatchObject({ added: 0, deleted: 0, binary: true })
      // The pre-turn dirty files are in both snapshots, so they contribute nothing.
      expect(byPath['B.txt']).toBeUndefined()
      expect(byPath['C.txt']).toBeUndefined()
      expect(byPath['ignored.txt']).toBeUndefined()

      // The repository's metadata is byte-for-byte where it started.
      expect(await fingerprint(repo)).toEqual(before)
      // ...and the user's own staged/unstaged split survived untouched, with the
      // turn's own edits added on top.
      expect(preserves(statusBefore, await statusLines(repo))).toBe(true)
    } finally {
      await cleanup(repo, scratch)
    }
  })

  test('snapshots a repository whose HEAD has no commit yet', async () => {
    const repo = await makeRepo('dsh-unborn')
    const scratch = await makeScratch()
    try {
      await write(repo, 'f.txt', 'hello\n')
      const workspace = await locateWorkspace(runCommand, executable, environment, repo, () => Promise.resolve(scratch), new AbortController().signal)
      expect(workspace).not.toBeNull()
      const signal = new AbortController().signal
      const before = await fingerprint(repo)
      const baseline = await snapshotTree(runCommand, executable, workspace!, join(scratch, 'index-base'), workspace!.excludes, signal)
      await write(repo, 'f.txt', 'hello\nworld\n')
      const end = await snapshotTree(runCommand, executable, workspace!, join(scratch, 'index-end'), workspace!.excludes, signal)
      const changes = await diffTrees(runCommand, executable, workspace!, baseline!, end!, signal)
      expect(changes.map((change) => change.path)).toEqual(['f.txt'])
      // No index exists in a fresh `git init`, and none must appear.
      expect(await fileDigest(join(repo, '.git', 'index'))).toBe(before['index'])
    } finally {
      await cleanup(repo, scratch)
    }
  })

  test('captures an edit that keeps the file s byte length', async () => {
    // Regression guard for a stat-cache race that a copied index loses: `two\n`
    // and `one\n` are both four bytes, so an index entry whose cached stat still
    // matches lets `git add` skip re-hashing and write the previous content. With
    // the repository's index copied in, this probe failed 2 times out of 40 on
    // this machine; seeding from HEAD fails none of them, and the loop makes the
    // assertion a real (if probabilistic) guard rather than a single coin flip.
    const repo = await makeRepo('dsh-samelen')
    const scratch = await makeScratch()
    const signal = new AbortController().signal
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const workspace = await locateWorkspace(runCommand, executable, environment, repo, () => Promise.resolve(scratch), signal)
    expect(workspace).not.toBeNull()
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        // Each round commits one four-byte line and edits it into another.
        const committed = `r${String(attempt)}a\n`
        const edited = `r${String(attempt)}b\n`
        await write(repo, 'a.txt', committed)
        await commitAll(repo, `round ${String(attempt)}`)
        await write(repo, 'a.txt', edited)
        const tree = await snapshotTree(runCommand, executable, workspace!, join(scratch, `index-${String(attempt)}`), workspace!.excludes, signal)
        expect(tree).not.toBeNull()
        // The tree lives in the private object store, so it is read through that
        // store with the repository's own store as the alternate.
        const entry = await runCommand({ file: executable, args: ['ls-tree', '-r', tree!, '--', 'a.txt'], cwd: repo, env: workspace!.env, timeoutMs: 10_000, maxBytes: 4_096, signal })
        // The tree must hold the working tree's content, not a cached older blob.
        expect(entry.stdout.trim().split(/\s+/u)[2]).toBe(await git(repo, ['hash-object', 'a.txt']))
      }
    } finally {
      await cleanup(repo, scratch)
    }
  })

  test('treats an identical pair of snapshots as no changes at all', async () => {
    const repo = await makeRepo('dsh-clean')
    const scratch = await makeScratch()
    try {
      await write(repo, 'a.txt', 'one\n')
      await commitAll(repo, 'init')
      const workspace = await locateWorkspace(runCommand, executable, environment, repo, () => Promise.resolve(scratch), new AbortController().signal)
      const signal = new AbortController().signal
      const tree = await snapshotTree(runCommand, executable, workspace!, join(scratch, 'index-base'), workspace!.excludes, signal)
      await expect(diffTrees(runCommand, executable, workspace!, tree!, tree!, signal)).resolves.toEqual([])
    } finally {
      await cleanup(repo, scratch)
    }
  })

  test('keeps the repository whole across a second turn, too', async () => {
    const repo = await makeRepo('dsh-repeat')
    const scratch = await makeScratch()
    const signal = new AbortController().signal
    try {
      await write(repo, 'a.txt', 'one\n')
      await commitAll(repo, 'init')
      const workspace = await locateWorkspace(runCommand, executable, environment, repo, () => Promise.resolve(scratch), new AbortController().signal)
      for (const turn of ['one', 'two']) {
        const before = await fingerprint(repo)
        const baseline = await snapshotTree(runCommand, executable, workspace!, join(scratch, `index-${turn}-base`), workspace!.excludes, signal)
        await write(repo, 'a.txt', `${turn}\n`)
        const end = await snapshotTree(runCommand, executable, workspace!, join(scratch, `index-${turn}-end`), workspace!.excludes, signal)
        await diffTrees(runCommand, executable, workspace!, baseline!, end!, signal)
        expect(await fingerprint(repo)).toEqual(before)
      }
      // Everything git wrote landed in the private directory, and nowhere else.
      expect((await stat(join(scratch, 'index-one-base'))).isFile()).toBe(true)
      expect((await stat(join(scratch, 'objects'))).isDirectory()).toBe(true)
    } finally {
      await cleanup(repo, scratch)
    }
  })
})

describe('the private scratch directory', () => {
  test('is created outside the work tree and removed on request', async () => {
    const scratch = await makeScratch()
    // Outside the work tree is what matters; the spelling is the platform's.
    expect(isAbsolute(scratch)).toBe(true)
    await removeScratch(scratch)
    await expect(stat(scratch)).rejects.toThrow()
  })

  test('never lets a repository index be written through GIT_INDEX_FILE', async () => {
    const repo = await makeRepo('dsh-index')
    const scratch = await makeScratch()
    try {
      await write(repo, 'a.txt', 'one\n')
      await commitAll(repo, 'init')
      const indexBefore = await fileDigest(join(repo, '.git', 'index'))
      const workspace = await locateWorkspace(runCommand, executable, environment, repo, () => Promise.resolve(scratch), new AbortController().signal)
      const signal = new AbortController().signal
      await write(repo, 'a.txt', 'two\n')
      await snapshotTree(runCommand, executable, workspace!, join(scratch, 'index-x'), workspace!.excludes, signal)
      // git refreshed nothing: the real index still describes the committed blob.
      expect(await fileDigest(join(repo, '.git', 'index'))).toBe(indexBefore)
      expect((await readFile(join(repo, '.git', 'index'))).length).toBeGreaterThan(0)
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('')
    } finally {
      await cleanup(repo, scratch)
    }
  })
})

describe('a directory no repository encloses', () => {
  test('gets a private repository the directory itself never sees', async () => {
    const plain = await makeDir('dsh-synthetic')
    const scratch = await makeScratch()
    try {
      await write(plain, 'a.txt', 'one\n')
      const workspace = await locateSyntheticWorkspace(runCommand, executable, environment, plain, scratch, new AbortController().signal)
      expect(workspace?.synthetic).toBe(true)
      expect(workspace?.root).toBe(await realpath(plain))
      expect(workspace?.gitDir).toBe(join(scratch, 'directory', '.git'))
      // The measured directory is untouched: no `.git`, no index, nothing.
      expect(await readdir(plain)).toEqual(['a.txt'])
    } finally {
      await cleanup(plain, scratch)
    }
  })

  test('measures one turn from the tree it opened with', async () => {
    const plain = await makeDir('dsh-synthetic-turn')
    const scratch = await makeScratch()
    const signal = new AbortController().signal
    try {
      await write(plain, 'a.txt', 'one\ntwo\n')
      const workspace = await locateSyntheticWorkspace(runCommand, executable, environment, plain, scratch, signal)
      if (workspace === null) throw new Error('a private repository was refused')
      const before = await snapshotSyntheticTree(runCommand, executable, workspace, GIT_TIMEOUT_MS, signal)
      await write(plain, 'a.txt', 'one\ntwo\nthree\n')
      await write(plain, 'fresh.txt', 'new\n')
      const after = await snapshotSyntheticTree(runCommand, executable, workspace, GIT_TIMEOUT_MS, signal)
      if (before === null || after === null) throw new Error('a snapshot was refused')
      expect(await diffTrees(runCommand, executable, workspace, before, after, signal)).toEqual([
        { path: 'a.txt', added: 1, deleted: 0, binary: false },
        { path: 'fresh.txt', added: 1, deleted: 0, binary: false },
      ])
    } finally {
      await cleanup(plain, scratch)
    }
  })

  test('applies the default excludes, so a dependency tree is never read', async () => {
    const plain = await makeDir('dsh-synthetic-excludes')
    const scratch = await makeScratch()
    const signal = new AbortController().signal
    try {
      await write(plain, 'kept.txt', 'one\n')
      await write(plain, 'node_modules/dep/index.js', 'module.exports = 1\n')
      const workspace = await locateSyntheticWorkspace(runCommand, executable, environment, plain, scratch, signal)
      if (workspace === null) throw new Error('a private repository was refused')
      const before = await snapshotSyntheticTree(runCommand, executable, workspace, GIT_TIMEOUT_MS, signal)
      await write(plain, 'kept.txt', 'one\ntwo\n')
      await write(plain, 'node_modules/dep/index.js', 'module.exports = 2\nmodule.exports = 3\n')
      const after = await snapshotSyntheticTree(runCommand, executable, workspace, GIT_TIMEOUT_MS, signal)
      if (before === null || after === null) throw new Error('a snapshot was refused')
      const changes = await diffTrees(runCommand, executable, workspace, before, after, signal)
      expect(changes.map((change) => change.path)).toEqual(['kept.txt'])
    } finally {
      await cleanup(plain, scratch)
    }
  })

  test('reports an embedded repository without inventing a line count', async () => {
    const plain = await makeDir('dsh-synthetic-nested')
    const scratch = await makeScratch()
    const signal = new AbortController().signal
    try {
      await write(plain, 'kept.txt', 'one\n')
      const inner = join(plain, 'nested')
      await mkdir(inner, { recursive: true })
      await git(inner, ['init', '-q', '.'])
      await git(inner, ['config', 'user.email', 'harness@example.invalid'])
      await git(inner, ['config', 'user.name', 'Harness'])
      await write(inner, 'inner.txt', 'one\n')
      await commitAll(inner, 'init')
      const workspace = await locateSyntheticWorkspace(runCommand, executable, environment, plain, scratch, signal)
      if (workspace === null) throw new Error('a private repository was refused')
      const before = await snapshotSyntheticTree(runCommand, executable, workspace, GIT_TIMEOUT_MS, signal)
      await write(inner, 'inner.txt', 'one\ntwo\n')
      await commitAll(inner, 'second')
      const after = await snapshotSyntheticTree(runCommand, executable, workspace, GIT_TIMEOUT_MS, signal)
      if (before === null || after === null) throw new Error('a snapshot was refused')
      // git records the directory as an embedded repository and calls the moved
      // pointer one added and one deleted line; nobody changed a line, so the
      // entry is reported as one without counts.
      expect(await diffSyntheticTrees(runCommand, executable, workspace, before, after, signal)).toEqual([
        { path: 'nested', added: 0, deleted: 0, binary: true },
      ])
    } finally {
      await cleanup(plain, scratch)
    }
  })
})

describe('what a failing git step reports', () => {
  /** A workspace stub: these specs drive the runner, never git itself. */
  const workspace: GitWorkspace = { root: '/plain', gitDir: '/scratch/directory/.git', scratch: '/scratch', env: {}, excludes: [], synthetic: true }

  /** A diagnostics sink that records what it was told. */
  function recorder(): { failures: GitFailure[]; steps: string[]; sink: GitDiagnostics } {
    const failures: GitFailure[] = []
    const steps: string[] = []
    return {
      failures,
      steps,
      sink: {
        failed: (event) => failures.push(event),
        step: (event) => steps.push(event.operation),
      },
    }
  }

  test('names the step, the exit code, git s words and the cost when an add fails', async () => {
    const { failures, sink } = recorder()
    const runner: CommandRunner = () => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: unable to read tree' })
    const tree = await snapshotSyntheticTree(runner, 'git', workspace, GIT_TIMEOUT_MS, new AbortController().signal, sink, { sessionId: 's1', attempt: 2 })
    expect(tree).toBeNull()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      operation: 'add --all (incremental)',
      sessionId: 's1',
      attempt: 2,
      root: '/plain',
      exitCode: 128,
      stderr: 'fatal: unable to read tree',
    })
    expect(failures[0]?.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  test('names the first pass as such, so a slow directory is distinguishable from a slow turn', async () => {
    const { failures, sink } = recorder()
    const runner: CommandRunner = () => Promise.resolve({ exitCode: 128, stdout: '', stderr: 'fatal: index file smaller than expected' })
    await snapshotSyntheticTree(runner, 'git', workspace, GIT_TIMEOUT_MS * 20, new AbortController().signal, sink, { sessionId: 's1', attempt: 1 })
    expect(failures[0]?.operation).toBe('add --all (first pass)')
  })

  test('reports a timeout as a warmup timeout rather than a bare message', async () => {
    const { failures, sink } = recorder()
    const runner: CommandRunner = () => Promise.reject(new Error('timed out after 600000ms: git add --all'))
    const tree = await snapshotSyntheticTree(runner, 'git', workspace, GIT_TIMEOUT_MS * 20, new AbortController().signal, sink, { sessionId: 's1', attempt: 1 })
    expect(tree).toBeNull()
    expect(failures[0]?.detail).toMatch(/warmup timeout/u)
    expect(failures[0]?.detail).toMatch(/timed out after 600000ms/u)
  })

  test('reports an abort as the disposal it is, not as a git failure', async () => {
    const { failures, sink } = recorder()
    const runner: CommandRunner = () => Promise.reject(new Error('aborted: git add --all'))
    await snapshotSyntheticTree(runner, 'git', workspace, GIT_TIMEOUT_MS, new AbortController().signal, sink)
    expect(failures[0]?.detail).toBe('aborted (workspace disposed)')
  })

  test('refuses a snapshot whose write-tree answered with something that is not a tree id', async () => {
    const { failures, sink } = recorder()
    const runner: CommandRunner = (request) => Promise.resolve(request.args[0] === 'write-tree'
      ? { exitCode: 0, stdout: 'not-a-tree\n', stderr: '' }
      : { exitCode: 0, stdout: '', stderr: '' })
    const tree = await snapshotSyntheticTree(runner, 'git', workspace, GIT_TIMEOUT_MS, new AbortController().signal, sink)
    expect(tree).toBeNull()
    expect(failures[0]).toMatchObject({ operation: 'write-tree', detail: 'the answer was not a tree id' })
  })
})

describe('sweeping scratch directories a dead host left behind', () => {
  /** One candidate directory carrying `marker`, with a chosen age. */
  async function candidate(root: string, name: string, marker: unknown, ageMs: number): Promise<string> {
    const dir = join(root, name)
    await mkdir(dir, { recursive: true })
    if (marker !== undefined) await writeFile(join(dir, '.dsh-chat-diff-legacy-scratch.json'), JSON.stringify(marker), 'utf8')
    const when = new Date(Date.now() - ageMs)
    await utimes(dir, when, when)
    return dir
  }

  const mine = { schema: 1, plugin: 'chat-diff-summary-legacy', kind: 'synthetic', pid: 4321, createdAt: new Date().toISOString() }
  const day = 24 * 60 * 60_000

  test('removes an old directory that carries this plugin s marker', async () => {
    const root = await makeDir('dsh-gc')
    try {
      const old = await candidate(root, 'dsh-probe-old', mine, day + 60_000)
      const result = await collectOrphanScratches({ label: 'dsh-probe', plugin: 'chat-diff-summary-legacy', root })
      expect(result.removed).toEqual([old])
      await expect(stat(old)).rejects.toThrow()
    } finally {
      await cleanup(root)
    }
  })

  test('leaves a directory that is too fresh to be an orphan', async () => {
    const root = await makeDir('dsh-gc')
    try {
      const fresh = await candidate(root, 'dsh-probe-fresh', mine, 1_000)
      const result = await collectOrphanScratches({ label: 'dsh-probe', plugin: 'chat-diff-summary-legacy', root })
      expect(result.removed).toEqual([])
      expect(result.kept).toEqual([fresh])
      expect((await stat(fresh)).isDirectory()).toBe(true)
    } finally {
      await cleanup(root)
    }
  })

  test('never removes a directory it cannot prove is its own', async () => {
    const root = await makeDir('dsh-gc')
    try {
      const bare = await candidate(root, 'dsh-probe-bare', undefined, day * 2)
      const foreign = await candidate(root, 'dsh-probe-foreign', { ...mine, plugin: 'somebody-else' }, day * 2)
      const otherSchema = await candidate(root, 'dsh-probe-schema', { ...mine, schema: 99 }, day * 2)
      const result = await collectOrphanScratches({ label: 'dsh-probe', plugin: 'chat-diff-summary-legacy', root })
      expect(result.removed).toEqual([])
      expect([...result.unrecognised].sort()).toEqual([bare, foreign, otherSchema].sort())
      for (const dir of [bare, foreign, otherSchema]) expect((await stat(dir)).isDirectory()).toBe(true)
    } finally {
      await cleanup(root)
    }
  })

  test('ignores a directory whose name does not carry the plugin s prefix', async () => {
    const root = await makeDir('dsh-gc')
    try {
      const other = await candidate(root, 'some-other-program-7f2', mine, day * 2)
      const result = await collectOrphanScratches({ label: 'dsh-probe', plugin: 'chat-diff-summary-legacy', root })
      expect(result.removed).toEqual([])
      expect(result.unrecognised).toEqual([])
      expect((await stat(other)).isDirectory()).toBe(true)
    } finally {
      await cleanup(root)
    }
  })

  test('says what it removed through diagnostics', async () => {
    const root = await makeDir('dsh-gc')
    const steps: string[] = []
    try {
      await candidate(root, 'dsh-probe-old', mine, day * 2)
      await collectOrphanScratches({
        label: 'dsh-probe',
        plugin: 'chat-diff-summary-legacy',
        root,
        diagnostics: { failed: () => {}, step: (event) => steps.push(event.operation) },
      })
      expect(steps).toEqual(['removed an orphaned scratch directory'])
    } finally {
      await cleanup(root)
    }
  })

  test('a directory this plugin just created is recognised as its own', async () => {
    const scratch = await createScratch('dsh-probe', { schema: 1, plugin: 'chat-diff-summary-legacy', kind: 'repository', pid: process.pid, createdAt: new Date().toISOString() })
    try {
      const marker = JSON.parse(await readFile(join(scratch, '.dsh-chat-diff-legacy-scratch.json'), 'utf8')) as { plugin: string; schema: number }
      expect(marker).toMatchObject({ plugin: 'chat-diff-summary-legacy', schema: 1 })
    } finally {
      await cleanup(scratch)
    }
  })
})
