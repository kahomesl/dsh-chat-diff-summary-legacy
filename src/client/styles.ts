/**
 * Styles for the change summary bar.
 *
 * Every colour is a DSH alias token, so light and dark themes come from the
 * host's own theme layer with no override of ours and no hardcoded RGB:
 * `--dsw-alias-state-success-primary` / `--dsw-alias-state-error-primary` are
 * the tokens the shipped surfaces colour their own `+`/`-` counts with, and
 * `--dsw-alias-interactive-bg-hover` is the shipped hover fill. Geometry follows
 * the brief: one 38px row, 14px radius, a 1px border, and no heavy shadow.
 *
 * The widget does not span the composer. The summary row shrinks to its own
 * contents — a compact pill around `N files changed  +a  -b` — and is centred, so
 * it reads as a floating chip over the conversation rather than as another
 * composer row. The label and the counts sit one character apart; nothing pushes
 * them to opposite edges. A label too long for the composer ellipsizes, and the
 * counts stay whole.
 *
 * The list it opens is one third of the composer's width, so a long file name
 * has room before it ellipsizes, and it widens as the composer narrows — a third
 * of a 420px composer could not hold a name and two counts — which is what the
 * container queries at the end of the sheet do.
 *
 * The list is taken **out of flow** and floats over the conversation: expanding
 * it must not push the transcript up or shrink the viewport above the composer.
 * The row keeps its 38px, the dock keeps its height, and the files simply cover
 * whatever is behind them. That is why the row is the only thing in flow, and the
 * list is positioned against the root with `bottom: 100%`.
 *
 * The list pages at seven rows: its height is exactly seven rows plus its own
 * padding, and the rest is reached by scrolling inside the panel. The wheel is
 * kept inside it (`overscroll-behavior: contain`) so reaching the last file does
 * not start scrolling the conversation behind the composer.
 *
 * The list is laid out with `column-reverse` so it grows *upward*: the summary
 * row stays anchored directly above the composer and the files unfold into the
 * empty conversation space above it. DOM order is unchanged (button first, list
 * second), so the reading and focus order still announces the summary before the
 * files it controls.
 *
 * The sheet is installed as a `<style>` tag, which is the module system's own
 * mechanism: `dsh-client-modules` inventories the tags a plugin factory injected
 * (`claimStyles`) and keys them by `data-plugin` / `data-plugin-css` for HMR.
 */

/** Identity of this plugin's style tag, so re-mounting never stacks a second copy. */
export const STYLE_TAG_ID = 'dsh-chat-diff-summary-legacy/styles'

/** The plugin id the module system claims injected tags for. */
export const STYLE_PLUGIN_ID = 'dsh-chat-diff-summary-legacy'

/** The bar's stylesheet. */
export const STYLES = `
.cdsl-root{container:cdsl / inline-size;position:relative;box-sizing:border-box;width:100%;min-width:0;
  display:flex;justify-content:center;
  --cdsl-row-height:38px;--cdsl-list-pad:6px;--cdsl-list-rows:7}
.cdsl-bar{box-sizing:border-box;width:max-content;max-width:100%;
  height:38px;display:flex;align-items:center;gap:1em;
  padding:0 14px;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;
  transition:background-color .12s}
.cdsl-bar:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cdsl-bar:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.cdsl-label{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary)}
.cdsl-counts{flex:none;display:inline-flex;align-items:center;gap:.75em;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.cdsl-added{color:var(--dsw-alias-state-success-primary)}
.cdsl-deleted{color:var(--dsw-alias-state-error-primary)}
.cdsl-list{position:absolute;left:50%;bottom:calc(100% + 2px);transform:translateX(-50%);z-index:1;
  box-sizing:border-box;width:33.3333%;min-width:min(320px,100%);max-width:100%;list-style:none;
  margin:0;padding:var(--cdsl-list-pad) 0;
  max-height:calc(var(--cdsl-list-rows) * var(--cdsl-row-height) + 2 * var(--cdsl-list-pad));
  overflow-y:auto;overscroll-behavior:contain;
  /* The row itself stays flat; only the floating panel carries the host's own
     elevation token, so it reads as a surface over the transcript. */
  box-shadow:var(--dsw-shadow-lv3,none);
  border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}
.cdsl-list::-webkit-scrollbar{width:8px}
.cdsl-list::-webkit-scrollbar-track{background:transparent}
.cdsl-list::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-border-l3));border-radius:4px}
.cdsl-list::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,var(--dsw-alias-border-l2))}
.cdsl-row{box-sizing:border-box;width:100%;min-width:0;height:var(--cdsl-row-height);display:flex;align-items:center;gap:12px;
  padding:0 16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.cdsl-path{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cdsl-note{flex:none;color:var(--dsw-alias-label-caption);font-size:11px}
.cdsl-rowCounts{flex:none;display:inline-flex;gap:8px;
  font-variant-numeric:tabular-nums;white-space:nowrap}
/* The row already shrinks to its contents, so only the list needs widening. */
@container cdsl (max-width:760px){
  .cdsl-list{width:50%}
}
@container cdsl (max-width:520px){
  .cdsl-bar{padding:0 10px;font-size:12px}
  .cdsl-list{width:100%}
}
@container cdsl (max-width:320px){
  .cdsl-bar{padding:0 8px}
  .cdsl-counts{gap:.6em}
}
`

/**
 * Install the stylesheet once per document.
 * @param doc - the document to install into; omitted in non-browser runs.
 */
export function installStyles(doc: Document | undefined = globalThis.document): void {
  if (doc === undefined) return
  if (doc.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.plugin = STYLE_PLUGIN_ID
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = STYLES
  doc.head.appendChild(tag)
}
