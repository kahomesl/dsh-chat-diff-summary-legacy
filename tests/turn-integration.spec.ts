// @vitest-environment node
/**
 * The whole host half, end to end, against a real repository.
 *
 * This is the spec the design exists for. A repository starts with the user's
 * own dirty state already in it — one staged file, one unstaged file — and the
 * turn then changes files the way an agent actually does: through a shell
 * command, not a file tool. Nothing but a working-tree-to-working-tree snapshot
 * pair can tell those two groups apart, and nothing but a private index can do
 * it without writing to the repository.
 */
import { describe, expect, test, vi } from 'vitest'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { MAX_FILES, SUMMARY_PATH, isChangeSummary, summaryUrl, type ChangeSummary } from '../src/summary.ts'
import { cleanup, commitAll, fileDigest, git, makeDir, makeRepo, treeDigest, write } from './support/repo.ts'
import { HostHarness, session, turnEnd, turnStart } from './support/host.ts'

/** Scratch directories currently present under the system temporary root. */
async function scratchDirs(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('dsh-chat-diff-legacy-'))
}

/**
 * Wait until this plugin owns no scratch directory beyond `baseline`.
 *
 * Disposal is asynchronous — the plugin's teardown races the last git call — so
 * the assertion is "eventually nothing survives", polled under a bound rather
 * than trusted to a fixed sleep.
 * @param baseline - the scratch directories that existed before the plugin ran.
 * @returns the leftover set once it is empty, or the set still present at the deadline.
 */
async function waitForScratchCleanup(baseline: readonly string[]): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const leftovers = (await scratchDirs()).filter((name) => !baseline.includes(name))
    if (leftovers.length === 0) return []
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return (await scratchDirs()).filter((name) => !baseline.includes(name))
}

/** Read one summary out of the plugin's own route. */
async function readSummary(harness: HostHarness, sessionId: string, turn?: number): Promise<Response> {
  const route = harness.routes.get(SUMMARY_PATH)
  if (route === undefined) throw new Error('the summary route is not registered')
  return route.fetch(new Request(`http://127.0.0.1${summaryUrl(sessionId, turn)}`))
}

/** A repository holding A (committed), B (staged dirty), C (unstaged dirty) and E (committed). */
async function makeBaselinedRepo(prefix: string): Promise<string> {
  const repo = await makeRepo(prefix)
  await write(repo, 'A.txt', 'a\nb\nc\n')
  await write(repo, 'B.txt', 'x\n')
  await write(repo, 'C.txt', 'e\nf\n')
  await write(repo, 'E.txt', 'gone\n')
  await commitAll(repo, 'init')
  // The user's own pre-turn state, which the turn must not be credited with.
  await write(repo, 'B.txt', 'x\ny\n')
  await git(repo, ['add', 'B.txt'])
  await write(repo, 'C.txt', 'e\nf\ng\n')
  return repo
}

/** Run a real shell command in the repository, the way an agent's `bash` call would. */
async function shell(repo: string, script: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  // The script is written for a POSIX shell. Windows has no `/bin/sh`, so the
  // shell that ships with Git for Windows runs the same script unchanged; that
  // keeps the spec's edit identical on every host.
  const candidates = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'] : ['/bin/sh']
  let lastError: unknown
  for (const shellPath of candidates) {
    try {
      await promisify(execFile)(shellPath, ['-c', script], { cwd: repo })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

describe('a real turn in a real repository', () => {
  test('reports the turn through the route and leaves the repository untouched', async () => {
    const repo = await makeBaselinedRepo('dsh-turn')
    const before = {
      index: await fileDigest(join(repo, '.git', 'index')),
      head: await git(repo, ['rev-parse', 'HEAD']),
      refs: await git(repo, ['for-each-ref']),
      objects: await treeDigest(join(repo, '.git', 'objects')),
      status: await git(repo, ['status', '--porcelain']),
    }
    const scratchBefore = await scratchDirs()
    const harness = new HostHarness()
    apply(harness.ctx)
    const id = 'session-turn'
    const bound = session(id, { cwd: repo })
    try {
      harness.emitSessionEvent(bound, turnStart(1))

      // The turn's first tool call. Its work happens inside the gated `next`, so
      // it can only run after the tracker's baseline snapshot has settled: if the
      // gate ever stopped holding the waterfall, the shell mutation would race the
      // baseline, be present in both snapshots, and A.txt would vanish from the
      // diff asserted below.
      await harness.runGate(id, 'bash', async () => {
        await shell(repo, [
          "printf 'a\\nB2\\nc\\nd\\n' > A.txt",
          "printf 'new\\nfile\\n' > D.txt",
          'rm E.txt',
        ].join('; '))
      })

      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate(id, 'settle')

      const response = await readSummary(harness, id)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const value: unknown = await response.json()
      expect(isChangeSummary(value)).toBe(true)
      const summary = value as ChangeSummary

      // Only what this turn did.
      expect(summary.turn).toBe(1)
      expect(summary.total).toBe(3)
      expect(summary.files.map((file) => file.display).sort()).toEqual(['A.txt', 'D.txt', 'E.txt'])
      const byPath = Object.fromEntries(summary.files.map((file) => [file.path, file]))
      expect(byPath['A.txt']).toMatchObject({ added: 2, deleted: 1 })
      expect(byPath['D.txt']).toMatchObject({ added: 2, deleted: 0 })
      expect(byPath['E.txt']).toMatchObject({ added: 0, deleted: 1 })
      // The baseline's own dirty files are not the agent's work.
      expect(byPath['B.txt']).toBeUndefined()
      expect(byPath['C.txt']).toBeUndefined()
      expect(summary.added).toBe(4)
      expect(summary.deleted).toBe(2)

      // The same turn, asked for by number, is the same answer.
      const addressed = await readSummary(harness, id, 1)
      expect(await addressed.json()).toEqual(value)

      // The repository is exactly where it started.
      expect(await fileDigest(join(repo, '.git', 'index'))).toBe(before.index)
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(before.head)
      expect(await git(repo, ['for-each-ref'])).toBe(before.refs)
      expect(await treeDigest(join(repo, '.git', 'objects'))).toBe(before.objects)
      const after = await git(repo, ['status', '--porcelain'])
      for (const line of before.status === '' ? [] : before.status.split('\n')) {
        expect(after).toContain(line)
      }
      // The user's staged/unstaged split survived the turn.
      expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('B.txt')
      expect(await git(repo, ['diff', '--name-only'])).toContain('C.txt')
    } finally {
      harness.dispose()
      // Nothing git wrote for this Session survives the plugin.
      expect(await waitForScratchCleanup(scratchBefore)).toEqual([])
      await cleanup(repo)
    }
  })

  test('keeps two Sessions in two repositories apart', async () => {
    const left = await makeBaselinedRepo('dsh-left')
    const right = await makeRepo('dsh-right')
    await write(right, 'only.txt', 'one\n')
    await commitAll(right, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      harness.emitSessionEvent(session('a', { cwd: left }), turnStart(1))
      await harness.runGate('a', 'a')
      await write(left, 'A.txt', 'changed\n')
      harness.emitSessionEvent(session('a', { cwd: left }), turnEnd(1))
      await harness.runGate('a', 'a-settle')

      harness.emitSessionEvent(session('b', { cwd: right }), turnStart(1))
      await harness.runGate('b', 'b')
      await write(right, 'fresh.txt', 'two\n')
      harness.emitSessionEvent(session('b', { cwd: right }), turnEnd(1))
      await harness.runGate('b', 'b-settle')

      const a = (await (await readSummary(harness, 'a')).json()) as ChangeSummary
      const b = (await (await readSummary(harness, 'b')).json()) as ChangeSummary
      expect(a.files.map((file) => file.path)).toEqual(['A.txt'])
      expect(b.files.map((file) => file.path)).toEqual(['fresh.txt'])
    } finally {
      harness.dispose()
      await cleanup(left, right)
    }
  })

  test('tracks a directory that no repository encloses, from its very first turn', async () => {
    const plain = await makeDir('dsh-notrepo')
    await write(plain, 'kept.txt', 'one\ntwo\n')
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: plain })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      // The tool gate is what waits for the whole-directory pass: by the time it
      // releases, the baseline exists, so this turn's own edit is measured
      // rather than lost. Accuracy is the reason the wait exists.
      await harness.runGate('s', 's')
      await write(plain, 'during.txt', 'written after the baseline\n')
      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate('s', 'settle')
      const summary = (await (await readSummary(harness, 's', 1)).json()) as ChangeSummary
      expect(summary.total).toBe(1)
      expect(summary.files.map((file) => file.path)).toEqual(['during.txt'])
      expect(summary.added).toBeGreaterThan(0)

      // The measured directory is left exactly as it was found: no `.git`, no
      // index, and only the files the turns wrote.
      expect((await readdir(plain)).sort()).toEqual(['during.txt', 'kept.txt'])
      expect(harness.warnings).toEqual([])
    } finally {
      harness.dispose()
      await cleanup(plain)
    }
  })

  test('shares one private repository between two Sessions in the same directory', async () => {
    const plain = await makeDir('dsh-shared-dir')
    await write(plain, 'kept.txt', 'one\n')
    const baseline = await scratchDirs()
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      for (const id of ['a', 'b']) {
        harness.emitSessionEvent(session(id, { cwd: plain }), turnStart(1))
        await harness.runGate(id, `${id}-open`)
        await write(plain, `${id}.txt`, 'x\n')
        harness.emitSessionEvent(session(id, { cwd: plain }), turnEnd(1))
        await harness.runGate(id, `${id}-close`)
      }
      // One directory, one workspace: the second Session cost a stat walk, not a
      // second whole-directory pass and a second object store.
      const created = (await scratchDirs()).filter((name) => !baseline.includes(name))
      expect(created).toHaveLength(1)
      const first = (await (await readSummary(harness, 'a', 1)).json()) as ChangeSummary
      const second = (await (await readSummary(harness, 'b', 1)).json()) as ChangeSummary
      // Each Session still reports only its own turn's work.
      expect(first.files.map((file) => file.path)).toEqual(['a.txt'])
      expect(second.files.map((file) => file.path)).toEqual(['b.txt'])
      expect(harness.warnings).toEqual([])
    } finally {
      harness.dispose()
      await cleanup(plain)
    }
  })

  test('measures later turns of a warmed directory without another pass', async () => {
    const plain = await makeDir('dsh-warm-fast')
    await write(plain, 'kept.txt', 'one\n')
    const baseline = await scratchDirs()
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: plain })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('s', 's1')
      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate('s', 'e1')

      harness.emitSessionEvent(bound, turnStart(2))
      await harness.runGate('s', 's2')
      await write(plain, 'second.txt', 'y\n')
      harness.emitSessionEvent(bound, turnEnd(2))
      await harness.runGate('s', 'e2')

      const summary = (await (await readSummary(harness, 's', 2)).json()) as ChangeSummary
      expect(summary.files.map((file) => file.path)).toEqual(['second.txt'])
      // The warmed directory is measured in place: no second workspace exists.
      expect((await scratchDirs()).filter((name) => !baseline.includes(name))).toHaveLength(1)
      expect(harness.warnings).toEqual([])
    } finally {
      harness.dispose()
      await cleanup(plain)
    }
  })

  test('keeps one Session working after the other one is disposed', async () => {
    const plain = await makeDir('dsh-shared-life')
    await write(plain, 'kept.txt', 'one\n')
    const baseline = await scratchDirs()
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      for (const id of ['a', 'b']) {
        harness.emitSessionEvent(session(id, { cwd: plain }), turnStart(1))
        await harness.runGate(id, `${id}-open`)
        harness.emitSessionEvent(session(id, { cwd: plain }), turnEnd(1))
        await harness.runGate(id, `${id}-close`)
      }
      harness.emitSessionDisposed(session('a', { cwd: plain }))
      // The surviving Session keeps its workspace: the first one's teardown does
      // not delete a repository another Session is still measuring through.
      harness.emitSessionEvent(session('b', { cwd: plain }), turnStart(2))
      await harness.runGate('b', 'b-open')
      await write(plain, 'b-later.txt', 'z\n')
      harness.emitSessionEvent(session('b', { cwd: plain }), turnEnd(2))
      await harness.runGate('b', 'b-close')
      const summary = (await (await readSummary(harness, 'b', 2)).json()) as ChangeSummary
      expect(summary.files.map((file) => file.path)).toEqual(['b-later.txt'])
      expect((await scratchDirs()).filter((name) => !baseline.includes(name))).toHaveLength(1)
    } finally {
      harness.dispose()
      await cleanup(plain)
    }
  })

  test('removes a shared workspace when the plugin is disposed', async () => {
    const plain = await makeDir('dsh-shared-dispose')
    await write(plain, 'kept.txt', 'one\n')
    const baseline = await scratchDirs()
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      harness.emitSessionEvent(session('s', { cwd: plain }), turnStart(1))
      await harness.runGate('s', 's')
      harness.emitSessionEvent(session('s', { cwd: plain }), turnEnd(1))
      await harness.runGate('s', 'settle')
      expect((await scratchDirs()).filter((name) => !baseline.includes(name))).toHaveLength(1)
    } finally {
      harness.dispose()
      // Plugin teardown is not subject to the idle window: it removes at once.
      expect(await waitForScratchCleanup(baseline)).toEqual([])
      await cleanup(plain)
    }
  })

  test('reports a clean turn as nothing to draw', async () => {
    const repo = await makeBaselinedRepo('dsh-clean-turn')
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      harness.emitSessionEvent(session('s', { cwd: repo }), turnStart(1))
      await harness.runGate('s', 's')
      harness.emitSessionEvent(session('s', { cwd: repo }), turnEnd(1))
      await harness.runGate('s', 'settle')
      const summary = (await (await readSummary(harness, 's')).json()) as ChangeSummary
      expect(summary.total).toBe(0)
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })

  test('counts a shell edit exactly once across consecutive turns', async () => {
    const repo = await makeRepo('dsh-consecutive')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: repo })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('s', 's1')
      await shell(repo, "printf 'two\\n' > a.txt")
      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate('s', 's1-settle')

      harness.emitSessionEvent(bound, turnStart(2))
      await harness.runGate('s', 's2')
      // The second turn touches nothing: the first turn's edit is now baseline.
      harness.emitSessionEvent(bound, turnEnd(2))
      await harness.runGate('s', 's2-settle')

      const first = (await (await readSummary(harness, 's', 1)).json()) as ChangeSummary
      const second = (await (await readSummary(harness, 's', 2)).json()) as ChangeSummary
      if (second.total !== 0) console.log('FLAKE second =', JSON.stringify(second))
      expect(first.files.map((file) => file.path)).toEqual(['a.txt'])
      expect(second.total).toBe(0)
      // `latest` follows the newest turn, so the bar does not re-serve turn 1.
      expect(((await (await readSummary(harness, 's')).json()) as ChangeSummary).turn).toBe(2)
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })

  test('never reports a delegated subagent Session', async () => {
    const repo = await makeRepo('dsh-subagent')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      harness.emitSessionEvent(session('child', { cwd: repo, origin: 'subagent' }), turnStart(1))
      await harness.runGate('child', 'child')
      await write(repo, 'a.txt', 'two\n')
      harness.emitSessionEvent(session('child', { cwd: repo, origin: 'subagent' }), turnEnd(1))
      await harness.runGate('child', 'child-settle')
      expect((await readSummary(harness, 'child')).status).toBe(204)
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })

  test('forgets a Session when the host disposes it', async () => {
    const repo = await makeRepo('dsh-disposed')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('gone', { cwd: repo })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('gone', 'g')
      await write(repo, 'b.txt', 'two\n')
      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate('gone', 'g-settle')
      expect((await readSummary(harness, 'gone')).status).toBe(200)
      harness.emitSessionDisposed(bound)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect((await readSummary(harness, 'gone')).status).toBe(204)
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })
})

describe('the summary route', () => {
  test('is registered exactly once, at the plugin s own path', () => {
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      expect(harness.registeredRoutes).toEqual([SUMMARY_PATH])
    } finally {
      harness.dispose()
    }
    expect(harness.registeredRoutes).toEqual([])
  })

  test('rejects a request that names no Session', async () => {
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      const route = harness.routes.get(SUMMARY_PATH)
      const response = await route?.fetch(new Request('http://127.0.0.1/api/x'))
      expect(response?.status).toBe(400)
    } finally {
      harness.dispose()
    }
  })

  test('rejects a malformed turn rather than guessing one', async () => {
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      const route = harness.routes.get(SUMMARY_PATH)
      for (const turn of ['abc', '-1', '1.5', '0', '']) {
        const response = await route?.fetch(new Request(`http://127.0.0.1/api/x?sessionId=s&turn=${turn}`))
        expect(response?.status).toBe(400)
      }
    } finally {
      harness.dispose()
    }
  })

  test('answers 204, and so logs nothing, for a Session this plugin never tracked', async () => {
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      // Not 404: every fresh Session asks once before it has completed a turn,
      // and a 404 is logged as a failed request in the renderer console.
      expect((await readSummary(harness, 'unknown')).status).toBe(204)
      expect((await readSummary(harness, 'unknown', 3)).status).toBe(204)
      const response = await readSummary(harness, 'unknown')
      expect(await response.text()).toBe('')
    } finally {
      harness.dispose()
    }
  })

  test('answers a turn that is still being measured instead of racing it', async () => {
    const repo = await makeRepo('dsh-race')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: repo })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('s', 's1')
      await write(repo, 'b.txt', 'two\n')
      harness.emitSessionEvent(bound, turnEnd(1))
      // No settle: this is the exact instant the browser learns the turn ended,
      // while the end snapshot and its diff are still running.
      const response = await readSummary(harness, 's', 1)
      expect(response.status).toBe(200)
      expect(((await response.json()) as ChangeSummary).files.map((file) => file.path)).toEqual(['b.txt'])
      await harness.runGate('s', 'settle')
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })

  test('shows the turn while it is still running, and grows as it goes', async () => {
    const repo = await makeRepo('dsh-live')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: repo })
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(5_000_000)
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('s', 's1')

      // Nothing has changed yet: the bar must stay hidden.
      expect((await readSummary(harness, 's', 1)).status).toBe(204)

      // First settled tool call: the route already answers, mid-turn.
      await write(repo, 'b.txt', 'two\n')
      harness.emitSessionEvent(bound, { type: 'tool/result', data: { turn: 1 } })
      const first = (await (await readSummary(harness, 's', 1)).json()) as ChangeSummary
      expect(first.files.map((file) => file.path)).toEqual(['b.txt'])

      // Second tool call, after the coalescing interval: the numbers grow.
      clock.mockReturnValue(5_000_000 + 400 + 1)
      await write(repo, 'c.txt', 'three\n')
      harness.emitSessionEvent(bound, { type: 'tool/result', data: { turn: 1 } })
      const second = (await (await readSummary(harness, 's', 1)).json()) as ChangeSummary
      expect(second.files.map((file) => file.path)).toEqual(['b.txt', 'c.txt'])

      // And the turn's own end still lands the authoritative numbers.
      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate('s', 'settle')
      const final = (await (await readSummary(harness, 's', 1)).json()) as ChangeSummary
      expect(final.total).toBe(2)
    } finally {
      clock.mockRestore()
      harness.dispose()
      await cleanup(repo)
    }
  })

  test('answers 204 for a turn the Session did not record', async () => {
    const repo = await makeRepo('dsh-route')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: repo })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('s', 's')
      await write(repo, 'b.txt', 'two\n')
      harness.emitSessionEvent(bound, turnEnd(1))
      await harness.runGate('s', 'settle')
      expect((await readSummary(harness, 's', 1)).status).toBe(200)
      expect((await readSummary(harness, 's', 2)).status).toBe(204)
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })
})

describe('the tool gate', () => {
  test('always continues the waterfall and never decides anything', async () => {
    const repo = await makeRepo('dsh-gate')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      harness.emitSessionEvent(session('s', { cwd: repo }), turnStart(1))
      expect(await harness.runGate('s', 'bash')).toBe('allowed')
      expect(harness.gateOrder).toEqual(['bash'])
      // A Session with no recorded turn passes straight through.
      expect(await harness.runGate('untracked', 'other')).toBe('allowed')
      // A call with no agent at all does too.
      const listener = harness.gateOrder.length
      expect(listener).toBe(2)
    } finally {
      harness.dispose()
      await cleanup(repo)
    }
  })

  test('releases the gate even when no snapshot work is pending', async () => {
    const harness = new HostHarness()
    apply(harness.ctx)
    try {
      await expect(harness.runGate('nothing-here')).resolves.toBe('allowed')
    } finally {
      harness.dispose()
    }
  })
})

describe('the scratch directory', () => {
  test('exists only while a Session is tracked', async () => {
    const repo = await makeRepo('dsh-scratch')
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'init')
    const baseline = await scratchDirs()
    const harness = new HostHarness()
    apply(harness.ctx)
    const bound = session('s', { cwd: repo })
    try {
      harness.emitSessionEvent(bound, turnStart(1))
      await harness.runGate('s', 's')
      const during = await scratchDirs()
      expect(during.length).toBe(baseline.length + 1)
      // git wrote the baseline tree into the private store, not the repository's.
      const scratch = join(tmpdir(), during.find((name) => !baseline.includes(name)) ?? '')
      expect((await stat(join(scratch, 'objects'))).isDirectory()).toBe(true)
      expect((await stat(join(scratch, 'index-base'))).isFile()).toBe(true)
    } finally {
      harness.dispose()
      expect(await waitForScratchCleanup(baseline)).toEqual([])
      await cleanup(repo)
    }
  })
})

describe('the file cap', () => {
  test('is large enough that an ordinary turn is never truncated', () => {
    expect(MAX_FILES).toBeGreaterThanOrEqual(100)
  })
})
