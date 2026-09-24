/**
 * The change summary bar: one lightweight rounded row above the composer
 * reading `{files} changed  +{added}  -{deleted}`.
 *
 * It draws nothing until a completed turn resolves to a summary that actually
 * changed files, so a clean turn, a Session that never completed one, and a
 * workspace that is not a git repository all render as absent rather than as a
 * zero.
 *
 * The numbers are never computed here: the host half owns turn boundaries and
 * the git working-tree snapshot, and this component only asks for the summary it
 * recorded for one Session.
 */
import { useEffect, useId, useState } from 'react'
import { formatCount, hasChanges } from '../summary.ts'
import type { ChangeSnapshot } from './summary-source.ts'
import { NS } from './locales.ts'

/** Translate one key of this plugin's namespace. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/**
 * The session-bound observable the dock entry injects, delivered as `useSummary`.
 *
 * A `hooks` source reaches the component as a *selector* hook, not as a bare
 * subscription: `@deepseek-ai/dsh-client-ui-renderer` binds it through
 * `bindSnapshotSelector`, whose hook is
 * `useSyncExternalStoreWithSelector(subscribe, getSnapshot, undefined, selector, isEqual)`.
 * Calling it with no selector hands `undefined` to the store and throws, so the
 * selector is not optional.
 */
export type UseSummary = <T>(selector: (state: ChangeSnapshot) => T) => T

/** Composed props of this dock entry: the injected hook and this namespace's copy. */
export interface ChatDiffSummaryProps {
  /**
   * The framework's hook seat for the `summary` source this plugin injects.
   * `@deepseek-ai/dsh-client-ui-slots` derives the prop name from the source name
   * via `standardHookPropName(name)` → `use` + capitalized name.
   */
  readonly useSummary: UseSummary
  readonly t: Translate
}

/**
 * Draw the summary bar for the Session this entry is mounted in.
 * @param props - composed dock props.
 * @returns the bar, or nothing when this turn changed no files.
 */
export function ChatDiffSummary({ useSummary, t }: ChatDiffSummaryProps) {
  // The selector returns the summary object itself, whose identity the source
  // keeps stable until a turn's numbers actually change.
  const summary = useSummary((state) => state.summary)
  const [expanded, setExpanded] = useState(false)
  const listId = useId()

  // A new turn's summary starts collapsed. Keyed on the turn rather than on the
  // summary object, because an open turn is re-measured while it runs and a
  // re-read of the same turn must not fold the list the user just opened.
  const turn = summary?.turn
  useEffect(() => {
    setExpanded(false)
  }, [turn])

  if (!hasChanges(summary)) return null
  const changed = summary.total === 1
    ? t('summary.changedOne', { count: formatCount(summary.total) })
    : t('summary.changed', { count: formatCount(summary.total) })
  const added = t('summary.added', { count: formatCount(summary.added) })
  const deleted = t('summary.deleted', { count: formatCount(summary.deleted) })
  const omitted = summary.total - summary.files.length

  return (
    <div className="cdsl-root" data-turn={turn}>
      <button
        type="button"
        className="cdsl-bar"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-label={`${changed}. ${added}, ${deleted}. ${t('summary.expand')}`}
        title={t('summary.expand')}
        onClick={() => {
          setExpanded((open) => !open)
        }}
      >
        <span className="cdsl-label">{changed}</span>
        <span className="cdsl-counts">
          <span className="cdsl-added" data-count="added">{added}</span>
          <span className="cdsl-deleted" data-count="deleted">{deleted}</span>
        </span>
      </button>
      {expanded && (
        <ul className="cdsl-list" id={listId} aria-label={t('summary.files')}>
          {summary.files.map((file) => (
            <li className="cdsl-row" key={file.path} title={file.path}>
              <span className="cdsl-path">{file.display}</span>
              {file.binary === true
                ? <span className="cdsl-note">{t('summary.binary')}</span>
                : (
                  <span className="cdsl-rowCounts">
                    <span className="cdsl-added">{t('summary.added', { count: formatCount(file.added) })}</span>
                    <span className="cdsl-deleted">{t('summary.deleted', { count: formatCount(file.deleted) })}</span>
                  </span>
                )}
            </li>
          ))}
          {omitted > 0 && (
            <li className="cdsl-row">
              <span className="cdsl-note">{t('summary.more', { count: formatCount(omitted) })}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/** Re-exported for specs that assert the namespace the entry declares. */
export { NS }
