/**
 * The bar's copy, in the two languages DSH Desktop 2.0.13 ships.
 *
 * A single line of text is not worth a translation service, but it is worth
 * registering properly: the slot's own `locale:` seat is what makes the bar
 * follow the active language, and an unregistered namespace would leave `t`
 * echoing dictionary keys into the UI.
 */

/** Dictionary namespace this plugin owns. */
export const NS = 'chat-diff-summary-legacy'

/**
 * Keys of this plugin's dictionary. The index signature is what lets a
 * dictionary be handed to the locale service as a `Record<string, string>`
 * without widening every lookup to `string`.
 */
export interface ChatDiffSummaryKey {
  readonly [key: string]: string
  'summary.changed': string
  'summary.changedOne': string
  'summary.added': string
  'summary.deleted': string
  'summary.expand': string
  'summary.files': string
  'summary.binary': string
  'summary.more': string
}

/** English copy. */
export const en: ChatDiffSummaryKey = {
  'summary.changed': '{count} files changed',
  'summary.changedOne': '{count} file changed',
  'summary.added': '+{count}',
  'summary.deleted': '-{count}',
  'summary.expand': 'Show or hide the files this turn changed',
  'summary.files': 'Files changed in this turn',
  'summary.binary': 'binary',
  'summary.more': '{count} more not listed',
}

/** Chinese copy. */
export const zh: ChatDiffSummaryKey = {
  'summary.changed': '{count} 个文件已更改',
  'summary.changedOne': '{count} 个文件已更改',
  'summary.added': '+{count}',
  'summary.deleted': '-{count}',
  'summary.expand': '展开或收起本轮改动的文件',
  'summary.files': '本轮改动的文件',
  'summary.binary': '二进制',
  'summary.more': '另有 {count} 个未列出',
}
