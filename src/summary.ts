/**
 * Shared contract between this plugin's two halves: the wire shape the host
 * route serves, the validators both sides run on it, and the identity strings
 * (route, slot entry id, plugin name) that must agree across the split.
 *
 * Deliberately free of any `@deepseek-ai/*` import so the contract can be read
 * by the browser bundle and by the Node host half alike.
 */

/** Stable Cordis plugin name, used as the loader identity of both halves. */
export const PLUGIN_NAME = 'chat-diff-summary-legacy'

/** The dock entry's id; unique among the shipped `queue`, `todo` and `goal` entries. */
export const ENTRY_ID = 'chat-diff-summary-legacy'

/** Authenticated route this plugin owns below `/api`; a third-party path, never a shipped one. */
export const SUMMARY_PATH = '/api/chat-diff-summary-legacy.summary'

/** BCP-47-ish locale ids this plugin's copy is registered for. */
export const LOCALE_IDS = ['en', 'zh'] as const

/** One changed file, as the route reports it. */
export interface ChangedFile {
  /** Repository-root-relative, slash-separated path. */
  readonly path: string
  /** Short label for the compact list: the basename when it is unique, else the full path. */
  readonly display: string
  /** Lines added; 0 for a binary file, which this plugin never counts. */
  readonly added: number
  /** Lines deleted; 0 for a binary file. */
  readonly deleted: number
  /** Present and true when git could not compute line counts for this file. */
  readonly binary?: true
}

/** One completed turn's working-tree change summary. */
export interface ChangeSummary {
  /** The turn whose changes this describes. */
  readonly turn: number
  /** Changed files in path order, already capped; `total` stays complete. */
  readonly files: readonly ChangedFile[]
  /** Complete changed-file count, including files the cap omitted. */
  readonly total: number
  /** Lines added over every counted file. */
  readonly added: number
  /** Lines deleted over every counted file. */
  readonly deleted: number
}

/** How many files one summary carries before the list is truncated. */
export const MAX_FILES = 200

/** How many completed turns one Session keeps, so a briefly lagging client still finds its turn. */
export const MAX_RETAINED_TURNS = 8

/** Thousands-group a count so a long total stays legible and its width stays stable. */
export function formatCount(value: number): string {
  // Deliberately not `Intl`: the separator must not move with the active
  // language, or the bar's width would shift on a locale switch.
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Whether a decoded value is one changed-file record the route may carry. */
export function isChangedFile(value: unknown): value is ChangedFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, display, added, deleted, binary } = value as Record<string, unknown>
  return typeof path === 'string' && path.length > 0
    && typeof display === 'string' && display.length > 0
    && Number.isSafeInteger(added) && (added as number) >= 0
    && Number.isSafeInteger(deleted) && (deleted as number) >= 0
    && (binary === undefined || binary === true)
}

/** Whether a decoded value is a summary this plugin is willing to draw. */
export function isChangeSummary(value: unknown): value is ChangeSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { turn, files, total, added, deleted } = value as Record<string, unknown>
  return Number.isSafeInteger(turn) && (turn as number) >= 1
    && Number.isSafeInteger(total) && (total as number) >= 0
    && Number.isSafeInteger(added) && (added as number) >= 0
    && Number.isSafeInteger(deleted) && (deleted as number) >= 0
    && Array.isArray(files) && files.every(isChangedFile)
}

/**
 * Whether a summary has anything to say.
 *
 * A turn that changed nothing is reported as `total === 0`, not by omitting the
 * record, so the bar has one rule for "nothing to draw".
 * @param summary - the summary, or the absence of one.
 * @returns whether the bar should render.
 */
export function hasChanges(summary: ChangeSummary | undefined): summary is ChangeSummary {
  return summary !== undefined && summary.total > 0
}

/**
 * Authenticated, origin-absolute URL of one Session's summary.
 * @param sessionId - the Session to summarize.
 * @param turn - the turn to read, or omitted for the newest completed turn.
 * @returns the URL the browser half fetches.
 */
export function summaryUrl(sessionId: string, turn?: number): string {
  const query = new URLSearchParams({ sessionId })
  if (turn !== undefined) query.set('turn', String(turn))
  return `${SUMMARY_PATH}?${query}`
}
