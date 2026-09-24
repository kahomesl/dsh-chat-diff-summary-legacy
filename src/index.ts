/**
 * Host half: turn boundaries, git working-tree snapshots, and the authenticated
 * summary route.
 *
 * This plugin owns a small legacy tracker instead of borrowing the official
 * workspace-change service, because DeepSeek Harness 0.1.5-rc.2 — the line
 * shipped inside DSH Desktop 2.0.13 — has no such service: no
 * `@deepseek-ai/dsh-workspace-changes` package, no `ctx.workspaceChanges`, no
 * `workspace/changes` Session event. The tracker is driven by the two real turn
 * boundaries of that line, `turn/start` and `turn/end`, observed through the
 * public `session/event` feed.
 *
 * The browser half never runs git and never sees a path: it fetches one
 * summary for one Session over the route registered here.
 */
import type { HostContext, SessionEventLike, SessionLike, ToolExecutionLike } from './host.ts'
import { runCommand } from './git.ts'
import { createEngineProvider, TurnTracker } from './tracker.ts'
import { PLUGIN_NAME, SUMMARY_PATH, type ChangeSummary } from './summary.ts'

/** Stable Loader identity; the browser half declares the same name. */
export const name = PLUGIN_NAME

/** Services required before the summary route can be registered. */
export const inject = ['connection'] as const

/** A non-negative turn number, or undefined when the query is absent. */
function turnCoordinate(raw: string | null): number | undefined {
  if (raw === null) return undefined
  if (!/^\d+$/u.test(raw)) return Number.NaN
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1 ? value : Number.NaN
}

/**
 * Answer the summary route for one Session.
 *
 * The route reads nothing but this plugin's own per-Session records: it carries
 * no path, no command, and no repository handle, so it cannot be turned into a
 * general git API by a caller.
 * @param tracker - the plugin's live tracker.
 * @param request - the authenticated request.
 * @returns the summary JSON, or the status explaining its absence.
 */
export async function handleSummary(tracker: TurnTracker, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('Invalid change summary coordinates.', { status: 400 })
  }
  const turn = turnCoordinate(query.get('turn'))
  if (turn !== undefined && Number.isNaN(turn)) {
    return new Response('Invalid change summary coordinates.', { status: 400 })
  }
  const summary: ChangeSummary | undefined = await tracker.completed(sessionId, turn)
  // "Nothing to draw yet" is the normal state of every Session that has not
  // completed a turn, so it answers 204 rather than 404: a 404 would be logged
  // as a failed request in the renderer console on every fresh Session. An
  // unknown Session answers the same way, which also avoids disclosing whether
  // an id exists.
  if (summary === undefined) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
  return Response.json(summary, { headers: { 'cache-control': 'no-store' } })
}

/** The turn number one `turn/start` or `turn/end` event carries, or undefined when malformed. */
function eventTurn(event: SessionEventLike): number | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const turn = (data as { turn?: unknown }).turn
  return Number.isSafeInteger(turn) && (turn as number) >= 1 ? (turn as number) : undefined
}

/**
 * Register turn tracking and the summary route.
 * @param ctx - host context carrying `connection`.
 */
export function apply(ctx: HostContext): void {
  const lifetime = new AbortController()
  const engine = createEngineProvider(runCommand, ctx.logger, lifetime.signal)
  const tracker = new TurnTracker(engine, ctx.logger, lifetime.signal)

  ctx.effect(() => async () => {
    lifetime.abort()
    // Awaited, so every Session's scratch directory is gone before the Loader
    // considers this plugin disposed.
    await tracker.dispose()
  }, 'chat-diff-summary-legacy: tracker')

  // `global: true` is what the shipped session and compaction invariants use:
  // the `session/event` feed is scope-dispatched, and a plugin-level listener
  // must bypass that filter or it silently receives nothing.
  ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    // A settled tool call is the moment the work tree may have moved, so it is
    // what re-measures an open turn. This is why the bar follows a running turn
    // instead of appearing only once the turn closes.
    if (event.type === 'tool/result') {
      tracker.progress(session.id)
      return
    }
    const turn = eventTurn(event)
    if (turn === undefined) return
    if (event.type === 'turn/start') {
      tracker.beginTurn(session.id, session.header.cwd, session.header.origin, session.header.delegationDepth ?? 0, turn)
      return
    }
    if (event.type === 'turn/end') tracker.endTurn(session.id, turn)
  }, { global: true })

  ctx.on('session/disposed', (session: SessionLike) => {
    void tracker.disposeSession(session.id)
  }, { global: true })

  // The baseline snapshot is a real git call and therefore asynchronous, while
  // `turn/start` is a fire-and-forget feed. Holding the tool waterfall until the
  // Session's queued snapshot work settles is what keeps a first `bash` (or
  // `fs`) call from mutating the work tree before its own baseline exists — the
  // same gate the official change service uses. It never decides anything: the
  // chain always continues, and a gate failure is contained.
  ctx.on('tools/pre-execute', async (exec: ToolExecutionLike, next: () => Promise<unknown>): Promise<unknown> => {
    try {
      const sessionId = exec.agent?.session.id
      if (typeof sessionId === 'string') await tracker.settle(sessionId)
    } catch (error) {
      ctx.logger.warn(`chat-diff-summary-legacy: change gate failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  }, { global: true })

  ctx.connection.fetch.register({
    path: SUMMARY_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request: Request) => handleSummary(tracker, request),
  })
}
