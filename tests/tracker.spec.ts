// @vitest-environment node
/**
 * Turn tracking semantics, against an injected engine so the interesting cases
 * — missing turn ends, two Sessions, consecutive turns, subagent Sessions — can
 * be driven deterministically.
 */
import { describe, expect, test, vi } from 'vitest'
import type { ChangeEngine } from '../src/tracker.ts'
import { createEngineProvider, PROGRESS_INTERVAL_MS, summarize, TurnTracker } from '../src/tracker.ts'
import type { CommandRunner, GitWorkspace, RawChange } from '../src/git.ts'
import { MAX_RETAINED_TURNS } from '../src/summary.ts'

/** What the fake engine returns for one call. */
interface Script {
  diff?: readonly RawChange[]
  snapshot?: string | null
  locate?: boolean
}

/** A scripted engine that records every call it received. */
class FakeEngine implements ChangeEngine {
  readonly calls: string[] = []
  readonly scratches: string[] = []
  readonly removed: string[] = []
  private readonly byLabel: Map<string, string | null>
  private readonly changes: readonly RawChange[]
  private readonly located: boolean

  constructor(script: Script = {}) {
    this.changes = script.diff ?? []
    this.located = script.locate ?? true
    this.byLabel = new Map()
    this.byLabel.set('base', script.snapshot === undefined ? 'base-tree' : script.snapshot)
    this.byLabel.set('end', 'end-tree')
    // An in-turn measurement; a distinct tree so a diff is produced.
    this.byLabel.set('live', 'live-tree')
  }

  /** Make one snapshot label answer with a specific tree. */
  setSnapshot(label: string, tree: string | null): void {
    this.byLabel.set(label, tree)
  }

  locate(cwd: string): Promise<GitWorkspace | null> {
    this.calls.push(`locate:${cwd}`)
    if (!this.located) return Promise.resolve(null)
    return Promise.resolve({ root: '/repo', gitDir: '/repo/.git', scratch: '/scratch', env: {}, excludes: [] })
  }

  snapshot(_workspace: GitWorkspace, label: string): Promise<string | null> {
    this.calls.push(`snapshot:${label}`)
    return Promise.resolve(this.byLabel.get(label) ?? null)
  }

  diff(_workspace: GitWorkspace, before: string, after: string): Promise<RawChange[]> {
    this.calls.push('diff')
    // Faithful to `diffTrees`, which short-circuits a pair of identical trees.
    return Promise.resolve(before === after ? [] : [...this.changes])
  }

  createScratch(): Promise<string> {
    const scratch = `/scratch-${String(this.scratches.length)}`
    this.scratches.push(scratch)
    return Promise.resolve(scratch)
  }

  removeScratch(scratch: string): Promise<void> {
    this.removed.push(scratch)
    return Promise.resolve()
  }
}

/** A tracker over a fake engine and a live lifetime signal. */
function trackerWith(engine: ChangeEngine): { tracker: TurnTracker; warnings: string[]; lifetime: AbortController } {
  const warnings: string[] = []
  const lifetime = new AbortController()
  const provider = (): Promise<ChangeEngine | null> => Promise.resolve(engine)
  return { tracker: new TurnTracker(provider, { warn: (message) => warnings.push(message) }, lifetime.signal), warnings, lifetime }
}

const CHANGES: readonly RawChange[] = [
  { path: 'src/b.ts', added: 2, deleted: 0, binary: false },
  { path: 'a.ts', added: 1, deleted: 3, binary: false },
]

describe('summarize', () => {
  test('orders files by path and totals every file', () => {
    const summary = summarize(7, CHANGES)
    expect(summary.turn).toBe(7)
    expect(summary.files.map((file) => file.path)).toEqual(['a.ts', 'src/b.ts'])
    expect(summary.total).toBe(2)
    expect(summary.added).toBe(3)
    expect(summary.deleted).toBe(3)
  })

  test('labels every row with its bare basename and keeps the full path on the file', () => {
    const summary = summarize(1, [
      { path: 'app/MainActivity.kt', added: 31, deleted: 4, binary: false },
      { path: 'README.md', added: 6, deleted: 0, binary: false },
      { path: 'other/MainActivity.kt', added: 1, deleted: 0, binary: false },
      { path: 'app/src/main/res/values/strings.xml', added: 8, deleted: 0, binary: false },
      { path: 'app/src/main/strings.xml', added: 7, deleted: 0, binary: false },
    ])
    // Rows sort by path and always show the bare basename, so a long path never
    // squeezes the counts off the line.
    expect(summary.files.map((file) => file.path)).toEqual([
      'README.md',
      'app/MainActivity.kt',
      'app/src/main/res/values/strings.xml',
      'app/src/main/strings.xml',
      'other/MainActivity.kt',
    ])
    expect(summary.files.map((file) => file.display)).toEqual([
      'README.md',
      'MainActivity.kt',
      'strings.xml',
      'strings.xml',
      'MainActivity.kt',
    ])
    // Two files may share a label; the row is still keyed and titled by its path.
    const strings = summary.files.filter((file) => file.display === 'strings.xml')
    expect(strings).toHaveLength(2)
    expect(strings.map((file) => file.path).sort()).toEqual(['app/src/main/res/values/strings.xml', 'app/src/main/strings.xml'])
  })

  test('reports a binary file without invented line counts', () => {
    const summary = summarize(1, [{ path: 'logo.png', added: 0, deleted: 0, binary: true }])
    expect(summary.total).toBe(1)
    expect(summary.added).toBe(0)
    expect(summary.deleted).toBe(0)
    expect(summary.files[0]?.binary).toBe(true)
  })

  test('reports nothing at all for a turn that changed nothing', () => {
    expect(summarize(3, [])).toEqual({ turn: 3, files: [], total: 0, added: 0, deleted: 0 })
  })
})

describe('a turn', () => {
  test('records the diff between its own start and end', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    expect(tracker.summary('s1')).toBeUndefined()
    tracker.endTurn('s1', 1)
    await tracker.settle('s1')
    expect(tracker.summary('s1')?.total).toBe(2)
    expect(engine.calls).toEqual(['locate:/repo', 'snapshot:base', 'snapshot:end', 'diff'])
  })

  test('reports a clean turn as zero files', async () => {
    const engine = new FakeEngine({ diff: [] })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    tracker.endTurn('s1', 1)
    await tracker.settle('s1')
    expect(tracker.summary('s1')).toEqual({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })
  })

  test('ignores a turn end that names a turn which is not open', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 4)
    tracker.endTurn('s1', 9)
    await tracker.settle('s1')
    expect(tracker.summary('s1')).toBeUndefined()
    expect(engine.calls).toEqual(['locate:/repo', 'snapshot:base'])
  })

  test('survives a turn that never ends, and cleans up on disposal', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    await tracker.settle('s1')
    // No `turn/end` ever arrives: nothing is announced, and the scratch goes away.
    expect(tracker.summary('s1')).toBeUndefined()
    await tracker.dispose()
    expect(engine.removed).toEqual(['/scratch-0'])
  })

  test('replaces a stale baseline when a new turn opens', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    tracker.beginTurn('s1', '/repo', undefined, 0, 2)
    await tracker.settle('s1')
    const baselineWrites = engine.calls.filter((call) => call === 'snapshot:base').length
    expect(baselineWrites).toBe(2)
    tracker.endTurn('s1', 2)
    await tracker.settle('s1')
    expect(tracker.summary('s1')?.turn).toBe(2)
  })

  test('holds nothing at all for a turn without a working directory', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', undefined, undefined, 0, 1)
    tracker.endTurn('s1', 1)
    await tracker.settle('s1')
    expect(engine.calls).toEqual([])
    expect(tracker.summary('s1')).toBeUndefined()
    await tracker.dispose()
    expect(engine.removed).toEqual([])
  })

  test('leaves a delegated subagent Session alone', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('child', '/repo', 'subagent', 0, 1)
    tracker.beginTurn('deep', '/repo', undefined, 2, 1)
    tracker.endTurn('child', 1)
    tracker.endTurn('deep', 1)
    await tracker.settle('child')
    await tracker.settle('deep')
    expect(engine.calls).toEqual([])
    expect(tracker.summary('child')).toBeUndefined()
    expect(tracker.summary('deep')).toBeUndefined()
  })

  test('keeps nothing when the directory is not a repository', async () => {
    const engine = new FakeEngine({ locate: false })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/plain', undefined, 0, 1)
    tracker.endTurn('s1', 1)
    await tracker.settle('s1')
    expect(tracker.summary('s1')).toEqual({ turn: 1, files: [], total: 0, added: 0, deleted: 0 })
    expect(tracker.summary('s1')?.total).toBe(0)
  })

  test('does not re-serve an older turn as this turn when git refuses the snapshot', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    tracker.endTurn('s1', 1)
    await tracker.settle('s1')
    expect(tracker.summary('s1')?.total).toBe(2)
    // The next turn's end snapshot fails.
    tracker.beginTurn('s1', '/repo', undefined, 0, 2)
    engine.setSnapshot('end', null)
    tracker.endTurn('s1', 2)
    await tracker.settle('s1')
    expect(tracker.summary('s1')).toEqual({ turn: 2, files: [], total: 0, added: 0, deleted: 0 })
    // The failed turn is still addressable by number, and is honestly empty.
    expect(tracker.summary('s1', 2)?.total).toBe(0)
    // The first turn is retained under its own number.
    expect(tracker.summary('s1', 1)?.total).toBe(2)
  })
})

describe('measuring a turn while it is still running', () => {
  test('records the turn so far, then lets the turn end replace it', async () => {
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(1_000_000)
      const engine = new FakeEngine({ diff: CHANGES })
      const { tracker } = trackerWith(engine)
      tracker.beginTurn('s1', '/repo', undefined, 0, 1)
      await tracker.settle('s1')
      expect(tracker.summary('s1')).toBeUndefined()

      tracker.progress('s1')
      await tracker.settle('s1')
      // The bar can draw the turn before it closes.
      expect(tracker.summary('s1')).toMatchObject({ turn: 1, total: 2 })

      clock.mockReturnValue(1_000_000 + PROGRESS_INTERVAL_MS + 1)
      engine.setSnapshot('live', 'mid-tree')
      tracker.progress('s1')
      await tracker.settle('s1')
      expect(engine.calls.filter((call) => call === 'snapshot:live').length).toBe(2)

      tracker.endTurn('s1', 1)
      await tracker.settle('s1')
      // The end measurement is authoritative and always runs.
      expect(engine.calls).toContain('snapshot:end')
      expect(tracker.summary('s1')).toMatchObject({ turn: 1, total: 2 })
    } finally {
      clock.mockRestore()
    }
  })

  test('coalesces a burst of tool results instead of walking the tree each time', async () => {
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(2_000_000)
      const engine = new FakeEngine({ diff: CHANGES })
      const { tracker } = trackerWith(engine)
      tracker.beginTurn('s1', '/repo', undefined, 0, 1)
      tracker.endTurn
      await tracker.settle('s1')
      for (let call = 0; call < 5; call += 1) tracker.progress('s1')
      await tracker.settle('s1')
      expect(engine.calls.filter((call) => call === 'snapshot:live').length).toBe(1)
      // Once the interval has passed, the next call measures again.
      clock.mockReturnValue(2_000_000 + PROGRESS_INTERVAL_MS + 1)
      tracker.progress('s1')
      await tracker.settle('s1')
      expect(engine.calls.filter((call) => call === 'snapshot:live').length).toBe(2)
    } finally {
      clock.mockRestore()
    }
  })

  test('measures nothing before a baseline exists, or with no open turn', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.progress('never-seen')
    await tracker.settle('never-seen')
    // A turn whose repository was never located has no baseline to compare to.
    tracker.beginTurn('plain', '/repo', undefined, 0, 1)
    tracker.progress('plain')
    await tracker.settle('plain')
    expect(engine.calls.filter((call) => call === 'snapshot:live')).toEqual([])
  })
})

describe('Session isolation', () => {
  test('never lets one Session read another one s numbers', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('a', '/repo', undefined, 0, 1)
    tracker.endTurn('a', 1)
    await tracker.settle('a')
    tracker.beginTurn('b', '/repo', undefined, 0, 1)
    tracker.endTurn('b', 1)
    await tracker.settle('b')
    expect(tracker.summary('a')?.total).toBe(2)
    expect(tracker.summary('b')?.total).toBe(2)
    await tracker.disposeSession('a')
    expect(tracker.summary('a')).toBeUndefined()
    // Session b is untouched by a's disposal.
    expect(tracker.summary('b')?.total).toBe(2)
    expect(engine.removed).toEqual(['/scratch-0'])
  })

  test('waits for a turn whose measurement is in flight', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    tracker.endTurn('s1', 1)
    // No settle: `completed` is asked before the queued work has run.
    await expect(tracker.completed('s1', 1)).resolves.toMatchObject({ turn: 1, total: 2 })
    // An unknown Session is not waited for at all.
    await expect(tracker.completed('nobody', 1)).resolves.toBeUndefined()
  })

  test('keeps consecutive turns of one Session apart', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('s1', '/repo', undefined, 0, 1)
    tracker.endTurn('s1', 1)
    await tracker.settle('s1')
    expect(tracker.summary('s1', 1)?.total).toBe(2)
    // The second turn changes nothing.
    engine.setSnapshot('base', 'base-tree-2')
    engine.setSnapshot('end', 'base-tree-2')
    tracker.beginTurn('s1', '/repo', undefined, 0, 2)
    tracker.endTurn('s1', 2)
    await tracker.settle('s1')
    expect(tracker.summary('s1')?.turn).toBe(2)
    expect(tracker.summary('s1', 2)?.total).toBe(0)
    expect(tracker.summary('s1', 1)?.total).toBe(2)
  })

  test('bounds how many turns one Session retains', async () => {
    const engine = new FakeEngine({ diff: [] })
    const { tracker } = trackerWith(engine)
    for (let turn = 1; turn <= MAX_RETAINED_TURNS + 3; turn += 1) {
      tracker.beginTurn('s1', '/repo', undefined, 0, turn)
      tracker.endTurn('s1', turn)
      await tracker.settle('s1')
    }
    expect(tracker.summary('s1')?.turn).toBe(MAX_RETAINED_TURNS + 3)
    expect(tracker.summary('s1', 1)).toBeUndefined()
    expect(tracker.summary('s1', MAX_RETAINED_TURNS + 3)).toBeDefined()
  })

  test('forgets every Session on plugin disposal', async () => {
    const engine = new FakeEngine({ diff: CHANGES })
    const { tracker } = trackerWith(engine)
    tracker.beginTurn('a', '/repo', undefined, 0, 1)
    tracker.endTurn('a', 1)
    await tracker.settle('a')
    await tracker.dispose()
    expect(tracker.summary('a')).toBeUndefined()
    expect(engine.removed).toEqual(['/scratch-0'])
  })
})

describe('the engine provider', () => {
  test('resolves git once and reuses the answer', async () => {
    const seen: string[] = []
    const runner: CommandRunner = (request) => {
      seen.push(request.file)
      if (request.file.endsWith('git')) return Promise.resolve({ exitCode: 0, stdout: 'git version 2.0.0\n', stderr: '' })
      return Promise.resolve({ exitCode: 0, stdout: '/Library/Developer\n', stderr: '' })
    }
    const provider = createEngineProvider(runner, { warn: () => {} }, new AbortController().signal)
    const first = await provider()
    const second = await provider()
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(seen.filter((file) => file.endsWith('git')).length).toBeLessThanOrEqual(1)
  })

  test('answers null and warns once when no git answers', async () => {
    const warnings: string[] = []
    const runner: CommandRunner = () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'nope' })
    if (process.platform === 'darwin') {
      // The macOS stub check fails first and short-circuits the candidate loop.
      const provider = createEngineProvider(runner, { warn: (message) => warnings.push(message) }, new AbortController().signal)
      await expect(provider()).resolves.toBeNull()
      expect(warnings).toHaveLength(1)
    }
  })
})
