/**
 * Browser half: mount the change summary bar into the composer's extension row.
 *
 * The bar registers into `conversation.input.dock` — the session-scoped *list*
 * the shipped composer renders as full-width entries above the composer card —
 * under an id of this plugin's own, so it sits beside the shipped `queue`,
 * `todo` and `goal` entries instead of replacing one. The composer, the
 * sidebar, and every shipped component are untouched, and no UI is injected
 * through the DOM: the only DOM this half writes is its own stylesheet.
 *
 * The summary is read, never computed: this half asks the host half for what its
 * tracker measured, one Session at a time.
 */
import type { ClientContext, ObservableLike, SessionBindingLike } from './contract.ts'
import { ChatDiffSummary, type ChatDiffSummaryProps } from './ChatDiffSummary.tsx'
import { en, NS, zh } from './locales.ts'
import { installStyles } from './styles.ts'
import { createDiffSummarySource, type ChangeSnapshot, type DiffSummarySource, type SummaryReader } from './summary-source.ts'
import type { ChangeSummary } from '../summary.ts'
import { ENTRY_ID, PLUGIN_NAME } from '../summary.ts'

/** Stable Loader identity, matching the host half's plugin row. */
export const name = PLUGIN_NAME

/** Slot registry, Session bindings, and this plugin's copy. */
export const inject = ['slots', 'sessions', 'locale'] as const

/** The source name injected into the entry; the renderer exposes it as `useSummary`. */
export const SUMMARY_SOURCE_NAME = 'summary'

/**
 * Build the session-bound source one mounted bar reads through.
 * @param ctx - client root context.
 * @param sessionId - the Session the entry is mounted in.
 * @param read - the request implementation; omitted in production.
 * @returns the observable source handed to the bar as `useSummary`.
 */
export function createSource(ctx: ClientContext, sessionId: string, read?: SummaryReader): DiffSummarySource {
  const binding: SessionBindingLike | undefined = ctx.sessions.binding(sessionId)
  return createDiffSummarySource(sessionId, binding, read)
}

/**
 * Client plugin body: install the stylesheet, register the dictionaries, and
 * register the dock entry under the plugin's own id.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'chat-diff-summary-legacy: dictionaries')

  // A replaced connection may reach a Host that has restarted and no longer
  // holds the summaries, so every live source re-reads.
  const sources = new Set<DiffSummarySource>()
  ctx.effect(() => {
    const off = ctx.on('connection/reset', () => {
      for (const source of [...sources]) source.refresh()
    })
    return () => {
      off()
      sources.clear()
    }
  }, 'chat-diff-summary-legacy: connection resets')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: ENTRY_ID,
    // Beside the shipped entries (todo 0, goal 10, queue 20), never over them.
    order: 30,
    locale: NS,
    inject: (sessionId: string) => {
      const source = createSource(ctx, sessionId)
      sources.add(source)
      // The framework converts a `hooks` entry into a `use<Name>` prop, so the
      // component receives this source as `useSummary`.
      return { hooks: { [SUMMARY_SOURCE_NAME]: source as ObservableLike<ChangeSnapshot> } }
    },
  }, ChatDiffSummary))
}

/** Exported for the registration and component specs. */
export { ChatDiffSummary, ENTRY_ID, type ChatDiffSummaryProps, type ChangeSummary }
