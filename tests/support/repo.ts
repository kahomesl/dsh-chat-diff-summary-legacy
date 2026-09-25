/**
 * Real-repository fixtures for the git specs.
 *
 * Everything runs against the `git` binary in a throwaway directory: the whole
 * point of these specs is that the tracker's safety claims are checked against
 * the repository it claims not to touch, not against a stub.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { createScratch } from '../../src/git.ts'

const run = promisify(execFile)

/** Run one git command in `cwd` and return its trimmed stdout. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return stdout.trim()
}

/** Create an empty directory under the system temporary root. */
export async function makeDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

/** Create a git repository with a deterministic identity and one commit. */
export async function makeRepo(prefix: string): Promise<string> {
  const dir = await makeDir(prefix)
  await git(dir, ['init', '-q', '.'])
  await git(dir, ['config', 'user.email', 'harness@example.invalid'])
  await git(dir, ['config', 'user.name', 'Harness'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

/** Write a file, creating its parent directories. */
export async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, content, 'utf8')
}

/** Commit everything currently in the work tree. */
export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '--all'])
  await git(repo, ['commit', '-q', '-m', message])
}

/** SHA-256 of one file's bytes, or the string `absent` when it does not exist. */
export async function fileDigest(path: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return 'absent'
  }
}

/** SHA-256 over a directory's sorted relative paths and their bytes. */
export async function treeDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    let names: string[]
    try {
      names = (await readdir(dir)).sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      let children: string[] | undefined
      try {
        children = await readdir(path)
      } catch {
        children = undefined
      }
      hash.update(relative(root, path).split(sep).join('/'))
      if (children === undefined) hash.update(await readFile(path))
      else await walk(path)
    }
  }
  await walk(root)
  return hash.digest('hex')
}

/** Remove a directory created by {@link makeDir} or {@link makeRepo}. */
export async function cleanup(...dirs: readonly string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
}

/** Create a private scratch directory the way the plugin's engine does, marker and all. */
export async function makeScratch(label = 'dsh-probe', kind: 'repository' | 'synthetic' = 'repository'): Promise<string> {
  return createScratch(label, {
    schema: 1,
    plugin: 'chat-diff-summary-legacy',
    kind,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  })
}
