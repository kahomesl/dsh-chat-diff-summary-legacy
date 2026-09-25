// @vitest-environment node
/**
 * The shared synthetic workspaces: one first pass per canonical directory, a
 * failed pass that is retried instead of remembered, and a scratch directory
 * whose lifetime follows its consumers.
 *
 * These specs drive the registry against a scripted engine, so the pass count,
 * the object store count and the backoff are exact numbers rather than timings.
 */
import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GitDiagnostics, GitFailure, GitWorkspace, ScratchMarker } from '../src/git.ts'
import type { WorkspaceEngine } from '../src/synthetic-workspace.ts'
import { SyntheticWorkspaces, WARMUP_BACKOFF_BASE_MS, WARMUP_BACKOFF_MAX_MS, workspaceKey } from '../src/synthetic-workspace.ts'
import { makeDir, cleanup } from './support/repo.ts'

/** A scripted engine: it counts passes and hands out fresh scratches. */
class FakeWorkspaces implements WorkspaceEngine {
  /** Absolute paths handed out, one per workspace created. */
  readonly scratches: string[] = []
  /** Scratch directories the registry asked to remove. */
  readonly removed: string[] = []
  /** How many first passes actually started. */
  passes = 0
  /** How many times a private repository was located. */
  locates = 0
  /** What each pass answers, in order; the last entry repeats. */
  outcomes: (string | null)[] = ['warm-tree']
  /** When true, a pass waits until {@link release} is called. */
  hold = false
  private readonly waiting: (() => void)[] = []

  locateDirectory(cwd: string, scratch: string): Promise<GitWorkspace | null> {
    this.locates += 1
    return Promise.resolve({ root: cwd, gitDir: join(scratch, 'directory', '.git'), scratch, env: {}, excludes: [], synthetic: true })
  }

  async snapshotDirectory(): Promise<string | null> {
    this.passes += 1
    if (this.hold) await new Promise<void>((resolve) => this.waiting.push(resolve))
    const index = Math.min(this.passes - 1, this.outcomes.length - 1)
    return this.outcomes[index] ?? null
  }

  createScratch(_kind: ScratchMarker['kind'], _root?: string): Promise<string> {
    const scratch = `/scratch-${String(this.scratches.length)}`
    this.scratches.push(scratch)
    return Promise.resolve(scratch)
  }

  removeScratch(scratch: string): Promise<void> {
    this.removed.push(scratch)
    return Promise.resolve()
  }

  /** Let every held pass finish. */
  release(): void {
    this.hold = false
    for (const resolve of this.waiting.splice(0)) resolve()
  }
}

/** A registry with a clock a spec controls. */
function registryWith(_engine: WorkspaceEngine, options: { idleMs?: number; backoffMaxMs?: number; aborted?: boolean } = {}): {
  registry: SyntheticWorkspaces
  warnings: string[]
  infos: string[]
  failures: GitFailure[]
  clock: { now: number }
} {
  const warnings: string[] = []
  const infos: string[] = []
  const failures: GitFailure[] = []
  const clock = { now: 1_000_000 }
  const abort = new AbortController()
  if (options.aborted === true) abort.abort()
  const diagnostics: GitDiagnostics = {
    failed: (event) => failures.push(event),
    step: () => {},
  }
  const registry = new SyntheticWorkspaces({ warn: (message) => warnings.push(message), info: (message) => infos.push(message) }, abort.signal, {
    idleMs: options.idleMs ?? 0,
    ...options.backoffMaxMs === undefined ? {} : { backoffMaxMs: options.backoffMaxMs },
    now: () => clock.now,
    diagnostics,
  })
  return { registry, warnings, infos, failures, clock }
}

const never = new AbortController().signal

describe('one workspace per directory', () => {
  test('runs the whole-directory pass once for two Sessions in the same directory', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine)
    const dir = await makeDir('dsh-shared')
    try {
      const first = await registry.prepare('a', dir, engine, never, 5_000)
      const second = await registry.prepare('b', dir, engine, never, 5_000)
      expect(first.ready).toBe(true)
      expect(second.ready).toBe(true)
      expect(first.entry).toBe(second.entry)
      expect(engine.passes).toBe(1)
      expect(engine.locates).toBe(1)
      expect(engine.scratches).toHaveLength(1)
      expect(registry.entriesHeld()).toHaveLength(1)
    } finally {
      await cleanup(dir)
    }
  })

  test('lets a Session arriving mid-pass join it instead of starting a second', async () => {
    const engine = new FakeWorkspaces()
    engine.hold = true
    const { registry } = registryWith(engine)
    const dir = await makeDir('dsh-join')
    try {
      const first = registry.prepare('a', dir, engine, never, Number.POSITIVE_INFINITY)
      // Wait for the pass to actually be in flight before the second caller asks.
      for (let attempt = 0; attempt < 100 && engine.passes === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      expect(engine.passes).toBe(1)
      const second = registry.prepare('b', dir, engine, never, Number.POSITIVE_INFINITY)
      engine.release()
      const [a, b] = await Promise.all([first, second])
      expect(a.ready).toBe(true)
      expect(b.ready).toBe(true)
      // Two Sessions, one pass, one object store.
      expect(engine.passes).toBe(1)
      expect(engine.scratches).toHaveLength(1)
    } finally {
      engine.release()
      await cleanup(dir)
    }
  })

  test('keeps a workspace while a budget expires, and hands it over when the pass lands', async () => {
    const engine = new FakeWorkspaces()
    engine.hold = true
    const { registry } = registryWith(engine)
    const dir = await makeDir('dsh-budget')
    try {
      const prepared = await registry.prepare('a', dir, engine, never, 5)
      expect(prepared.ready).toBe(false)
      expect(engine.passes).toBe(1)
      engine.release()
      // The pass was never cut short by the caller's budget.
      await registry.ready(prepared.entry!, engine, never, 5_000)
      expect(prepared.entry?.state).toBe('ready')
      expect(engine.passes).toBe(1)
    } finally {
      engine.release()
      await cleanup(dir)
    }
  })

  test('shares one workspace across spellings of the same path', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine)
    const dir = await makeDir('dsh-case')
    try {
      if (process.platform !== 'win32') {
        // Case marks different directories on POSIX, so the premise does not hold.
        expect(await workspaceKey(dir)).toBe(await workspaceKey(dir))
        return
      }
      const upper = dir.toUpperCase()
      const lower = dir.toLowerCase()
      await registry.prepare('a', upper, engine, never, 5_000)
      await registry.prepare('b', lower, engine, never, 5_000)
      expect(engine.scratches).toHaveLength(1)
      expect(engine.passes).toBe(1)
    } finally {
      await cleanup(dir)
    }
  })

  test('keys two unrelated absolute workspaces apart, and neither is the plugin s own directory', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine)
    // Two absolute paths that share nothing but the platform: one under the
    // system temporary root, one beside it. Neither is the plugin's source
    // directory, which is the point: the plugin is installed once for a profile
    // and measures whatever directory each Session reports.
    const first = await makeDir('dsh-scope-a')
    const second = await makeDir('dsh-scope-b')
    const source = fileURLToPath(new URL('..', import.meta.url))
    try {
      const preparedA = await registry.prepare('a', first, engine, never, 5_000)
      const preparedB = await registry.prepare('b', second, engine, never, 5_000)
      expect(preparedA.entry).not.toBe(preparedB.entry)
      expect(preparedA.entry?.key).toBe(await workspaceKey(first))
      expect(preparedB.entry?.key).toBe(await workspaceKey(second))
      expect(preparedA.entry?.key).not.toBe(preparedB.entry?.key)
      // Neither workspace is the directory the plugin is installed from.
      for (const entry of [preparedA.entry, preparedB.entry]) {
        expect(entry?.root.toLowerCase()).not.toBe(source.toLowerCase())
        expect(entry?.root.toLowerCase().startsWith(source.toLowerCase())).toBe(false)
      }
      // Two directories, two first passes, two object stores — and one plugin.
      expect(engine.passes).toBe(2)
      expect(engine.scratches).toHaveLength(2)
    } finally {
      await cleanup(first, second)
    }
  })
})

describe('a failed first pass', () => {
  test('is retried on a later turn instead of being remembered as permanent', async () => {
    const engine = new FakeWorkspaces()
    engine.outcomes = [null, 'warm-tree']
    const { registry, failures, clock } = registryWith(engine)
    const dir = await makeDir('dsh-retry')
    try {
      const first = await registry.prepare('a', dir, engine, never, 5_000)
      expect(first.ready).toBe(false)
      expect(first.entry?.state).toBe('failed')
      expect(engine.passes).toBe(1)
      expect(failures[0]).toMatchObject({ operation: 'first pass over the directory', attempt: 1 })

      // Inside the backoff window nothing is retried.
      await registry.ready(first.entry!, engine, never, 5_000)
      expect(engine.passes).toBe(1)

      // Past it, the next turn tries again and the directory is measured.
      clock.now += WARMUP_BACKOFF_BASE_MS + 1
      const ready = await registry.ready(first.entry!, engine, never, 5_000)
      expect(ready).toBe(true)
      expect(first.entry?.state).toBe('ready')
      expect(engine.passes).toBe(2)
      expect(first.entry?.lastFailure).toBeUndefined()
    } finally {
      await cleanup(dir)
    }
  })

  test('waits a doubling, capped interval between attempts', async () => {
    const engine = new FakeWorkspaces()
    engine.outcomes = [null]
    const { registry, clock, infos } = registryWith(engine, { backoffMaxMs: 4 * WARMUP_BACKOFF_BASE_MS })
    const dir = await makeDir('dsh-backoff')
    try {
      const prepared = await registry.prepare('a', dir, engine, never, 5_000)
      const expected = [1_000, 2_000, 4_000, 4_000, 4_000]
      for (const [index, delay] of expected.entries()) {
        expect(engine.passes).toBe(index + 1)
        // One millisecond short of the delay: still backing off.
        clock.now += delay - 1
        await registry.ready(prepared.entry!, engine, never, 5_000)
        expect(engine.passes).toBe(index + 1)
        clock.now += 1
        await registry.ready(prepared.entry!, engine, never, 5_000)
        expect(engine.passes).toBe(index + 2)
      }
      expect(prepared.entry?.attempts).toBe(expected.length + 1)
      expect(infos.some((line) => /first pass failed/u.test(line))).toBe(true)
    } finally {
      await cleanup(dir)
    }
  })

  test('stops growing the backoff once it reaches its ceiling', async () => {
    const engine = new FakeWorkspaces()
    engine.outcomes = [null]
    const { registry, clock } = registryWith(engine)
    const dir = await makeDir('dsh-ceiling')
    try {
      const prepared = await registry.prepare('a', dir, engine, never, 5_000)
      let expected = WARMUP_BACKOFF_BASE_MS
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        expect(prepared.entry?.retryAt).toBe(clock.now + expected)
        clock.now += expected
        await registry.ready(prepared.entry!, engine, never, 5_000)
        expected = Math.min(expected * 2, WARMUP_BACKOFF_MAX_MS)
      }
      // A directory that keeps failing is retried, but never more often than the
      // ceiling allows: the cost of a pass is what the ceiling protects.
      expect(prepared.entry?.retryAt).toBe(clock.now + WARMUP_BACKOFF_MAX_MS)
      expect(WARMUP_BACKOFF_MAX_MS).toBeGreaterThan(WARMUP_BACKOFF_BASE_MS)
    } finally {
      await cleanup(dir)
    }
  })

  test('does not start a pass once the plugin is being disposed', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine, { aborted: true })
    const dir = await makeDir('dsh-aborted')
    try {
      const prepared = await registry.prepare('a', dir, engine, never, 5_000)
      expect(prepared.ready).toBe(false)
      expect(engine.passes).toBe(0)
      expect(prepared.entry?.lastFailure).toMatch(/aborted/u)
    } finally {
      await cleanup(dir)
    }
  })
})

describe('the scratch directory lifetime', () => {
  test('is removed when the last Session lets go', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine, { idleMs: 0 })
    const dir = await makeDir('dsh-retire')
    try {
      const prepared = await registry.prepare('a', dir, engine, never, 5_000)
      await registry.release('a')
      expect(engine.removed).toEqual([engine.scratches[0]])
      expect(registry.entriesHeld()).toEqual([])
      expect(prepared.entry?.consumers.size).toBe(0)
    } finally {
      await cleanup(dir)
    }
  })

  test('survives one Session s disposal while another still holds it', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine, { idleMs: 0 })
    const dir = await makeDir('dsh-hold')
    try {
      const first = await registry.prepare('a', dir, engine, never, 5_000)
      await registry.prepare('b', dir, engine, never, 5_000)
      await registry.release('a')
      expect(engine.removed).toEqual([])
      expect(first.entry?.consumers).toEqual(new Set(['b']))
      expect(await registry.ready(first.entry!, engine, never, 5_000)).toBe(true)
      await registry.release('b')
      expect(engine.removed).toEqual([engine.scratches[0]])
    } finally {
      await cleanup(dir)
    }
  })

  test('is kept for the idle window and reused by the next Session', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine, { idleMs: 60_000 })
    const dir = await makeDir('dsh-idle')
    try {
      await registry.prepare('a', dir, engine, never, 5_000)
      await registry.release('a')
      expect(engine.removed).toEqual([])
      // A Session that arrives inside the window claims the same pass.
      await registry.prepare('b', dir, engine, never, 5_000)
      expect(engine.passes).toBe(1)
      expect(engine.scratches).toHaveLength(1)
      await registry.release('b')
    } finally {
      await cleanup(dir)
    }
  })

  test('is removed for every directory when the plugin is disposed', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine, { idleMs: 60_000 })
    const first = await makeDir('dsh-dispose-a')
    const second = await makeDir('dsh-dispose-b')
    try {
      await registry.prepare('a', first, engine, never, 5_000)
      await registry.prepare('b', second, engine, never, 5_000)
      await registry.disposeAll()
      expect(engine.removed.sort()).toEqual([...engine.scratches].sort())
      expect(registry.entriesHeld()).toEqual([])
      // A disposed registry hands out nothing.
      const after = await registry.prepare('c', first, engine, never, 5_000)
      expect(after).toEqual({ entry: undefined, workspace: null, ready: false })
    } finally {
      await cleanup(first, second)
    }
  })
})

describe('what the registry reports', () => {
  test('a Session that moves to another directory releases the first workspace', async () => {
    const engine = new FakeWorkspaces()
    const { registry } = registryWith(engine, { idleMs: 0 })
    const first = await makeDir('dsh-move-a')
    const second = await makeDir('dsh-move-b')
    try {
      await registry.prepare('a', first, engine, never, 5_000)
      await registry.prepare('a', second, engine, never, 5_000)
      expect(engine.removed).toEqual([engine.scratches[0]])
      expect(registry.entriesHeld()).toHaveLength(1)
      expect(registry.entriesHeld()[0]?.consumers).toEqual(new Set(['a']))
    } finally {
      await cleanup(first, second)
    }
  })

  test('a directory that cannot be canonicalized is refused with a reason', async () => {
    const engine = new FakeWorkspaces()
    const { registry, failures } = registryWith(engine)
    const prepared = await registry.prepare('a', join(await makeDir('dsh-gone'), 'no-such-child'), engine, never, 5_000)
    expect(prepared).toEqual({ entry: undefined, workspace: null, ready: false })
    expect(failures[0]?.operation).toBe('realpath (workspace key)')
  })

  test('a pass that fails names the attempt and the directory', async () => {
    const engine = new FakeWorkspaces()
    engine.outcomes = [null]
    const { registry, failures } = registryWith(engine)
    const dir = await makeDir('dsh-report')
    try {
      await registry.prepare('a', dir, engine, never, 5_000)
      expect(failures[0]).toMatchObject({ operation: 'first pass over the directory', attempt: 1, sessionId: 'a' })
      expect(failures[0]?.detail).toBe('git refused the snapshot')
      expect(failures[0]?.root?.toLowerCase()).toBe(dir.toLowerCase())
    } finally {
      await cleanup(dir)
    }
  })
})
