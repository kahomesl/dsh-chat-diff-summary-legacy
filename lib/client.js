window.__ModuleLoader__.load({ id: "dsh-chat-diff-summary-legacy", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/summary.ts
/**
* Shared contract between this plugin's two halves: the wire shape the host
* route serves, the validators both sides run on it, and the identity strings
* (route, slot entry id, plugin name) that must agree across the split.
*
* Deliberately free of any `@deepseek-ai/*` import so the contract can be read
* by the browser bundle and by the Node host half alike.
*/
/** Stable Cordis plugin name, used as the loader identity of both halves. */
const PLUGIN_NAME = "chat-diff-summary-legacy";
/** The dock entry's id; unique among the shipped `queue`, `todo` and `goal` entries. */
const ENTRY_ID = "chat-diff-summary-legacy";
/** Authenticated route this plugin owns below `/api`; a third-party path, never a shipped one. */
const SUMMARY_PATH = "/api/chat-diff-summary-legacy.summary";
/** Thousands-group a count so a long total stays legible and its width stays stable. */
function formatCount(value) {
	return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/** Whether a decoded value is one changed-file record the route may carry. */
function isChangedFile(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const { path, display, added, deleted, binary } = value;
	return typeof path === "string" && path.length > 0 && typeof display === "string" && display.length > 0 && Number.isSafeInteger(added) && added >= 0 && Number.isSafeInteger(deleted) && deleted >= 0 && (binary === void 0 || binary === true);
}
/** Whether a decoded value is a summary this plugin is willing to draw. */
function isChangeSummary(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const { turn, files, total, added, deleted } = value;
	return Number.isSafeInteger(turn) && turn >= 1 && Number.isSafeInteger(total) && total >= 0 && Number.isSafeInteger(added) && added >= 0 && Number.isSafeInteger(deleted) && deleted >= 0 && Array.isArray(files) && files.every(isChangedFile);
}
/**
* Whether a summary has anything to say.
*
* A turn that changed nothing is reported as `total === 0`, not by omitting the
* record, so the bar has one rule for "nothing to draw".
* @param summary - the summary, or the absence of one.
* @returns whether the bar should render.
*/
function hasChanges(summary) {
	return summary !== void 0 && summary.total > 0;
}
/**
* Authenticated, origin-absolute URL of one Session's summary.
* @param sessionId - the Session to summarize.
* @param turn - the turn to read, or omitted for the newest completed turn.
* @returns the URL the browser half fetches.
*/
function summaryUrl(sessionId, turn) {
	const query = new URLSearchParams({ sessionId });
	if (turn !== void 0) query.set("turn", String(turn));
	return `${SUMMARY_PATH}?${query}`;
}

//#endregion
//#region src/client/locales.ts
/**
* The bar's copy, in the two languages DSH Desktop 2.0.13 ships.
*
* A single line of text is not worth a translation service, but it is worth
* registering properly: the slot's own `locale:` seat is what makes the bar
* follow the active language, and an unregistered namespace would leave `t`
* echoing dictionary keys into the UI.
*/
/** Dictionary namespace this plugin owns. */
const NS = "chat-diff-summary-legacy";
/** English copy. */
const en = {
	"summary.changed": "{count} files changed",
	"summary.changedOne": "{count} file changed",
	"summary.added": "+{count}",
	"summary.deleted": "-{count}",
	"summary.expand": "Show or hide the files this turn changed",
	"summary.files": "Files changed in this turn",
	"summary.binary": "binary",
	"summary.more": "{count} more not listed"
};
/** Chinese copy. */
const zh = {
	"summary.changed": "{count} 个文件已更改",
	"summary.changedOne": "{count} 个文件已更改",
	"summary.added": "+{count}",
	"summary.deleted": "-{count}",
	"summary.expand": "展开或收起本轮改动的文件",
	"summary.files": "本轮改动的文件",
	"summary.binary": "二进制",
	"summary.more": "另有 {count} 个未列出"
};

//#endregion
//#region src/client/ChatDiffSummary.tsx
/**
* Draw the summary bar for the Session this entry is mounted in.
* @param props - composed dock props.
* @returns the bar, or nothing when this turn changed no files.
*/
function ChatDiffSummary({ useSummary, t }) {
	const summary = useSummary((state) => state.summary);
	const [expanded, setExpanded] = (0, react.useState)(false);
	const listId = (0, react.useId)();
	const turn = summary?.turn;
	(0, react.useEffect)(() => {
		setExpanded(false);
	}, [turn]);
	if (!hasChanges(summary)) return null;
	const changed = summary.total === 1 ? t("summary.changedOne", { count: formatCount(summary.total) }) : t("summary.changed", { count: formatCount(summary.total) });
	const added = t("summary.added", { count: formatCount(summary.added) });
	const deleted = t("summary.deleted", { count: formatCount(summary.deleted) });
	const omitted = summary.total - summary.files.length;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "cdsl-root",
		"data-turn": turn,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			className: "cdsl-bar",
			"aria-expanded": expanded,
			"aria-controls": listId,
			"aria-label": `${changed}. ${added}, ${deleted}. ${t("summary.expand")}`,
			title: t("summary.expand"),
			onClick: () => {
				setExpanded((open) => !open);
			},
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "cdsl-label",
				children: changed
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "cdsl-counts",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cdsl-added",
					"data-count": "added",
					children: added
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cdsl-deleted",
					"data-count": "deleted",
					children: deleted
				})]
			})]
		}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
			className: "cdsl-list",
			id: listId,
			"aria-label": t("summary.files"),
			children: [summary.files.map((file) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: "cdsl-row",
				title: file.path,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cdsl-path",
					children: file.display
				}), file.binary === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cdsl-note",
					children: t("summary.binary")
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					className: "cdsl-rowCounts",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cdsl-added",
						children: t("summary.added", { count: formatCount(file.added) })
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "cdsl-deleted",
						children: t("summary.deleted", { count: formatCount(file.deleted) })
					})]
				})]
			}, file.path)), omitted > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
				className: "cdsl-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "cdsl-note",
					children: t("summary.more", { count: formatCount(omitted) })
				})
			})]
		})]
	});
}

//#endregion
//#region src/client/styles.ts
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
const STYLE_TAG_ID = "dsh-chat-diff-summary-legacy/styles";
/** The plugin id the module system claims injected tags for. */
const STYLE_PLUGIN_ID = "dsh-chat-diff-summary-legacy";
/** The bar's stylesheet. */
const STYLES = `
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
`;
/**
* Install the stylesheet once per document.
* @param doc - the document to install into; omitted in non-browser runs.
*/
function installStyles(doc = globalThis.document) {
	if (doc === void 0) return;
	if (doc.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return;
	const tag = doc.createElement("style");
	tag.dataset.plugin = STYLE_PLUGIN_ID;
	tag.dataset.pluginCss = STYLE_TAG_ID;
	tag.textContent = STYLES;
	doc.head.appendChild(tag);
}

//#endregion
//#region src/client/turn-window.ts
/** The turn a boundary payload names, or undefined when it is malformed. */
function announcedTurn(data) {
	if (typeof data !== "object" || data === null) return void 0;
	const turn = data.turn;
	return Number.isSafeInteger(turn) && turn >= 1 ? turn : void 0;
}
/**
* Find the newest turn boundary and the newest durable sequence in one window.
*
* The window is contiguous but may be a tail slice, so both answers are the
* highest sequences carrying the right shape rather than the last entry in
* reading order.
* @param window - the Session binding's event window, or undefined before a binding exists.
* @returns the position; a window with no turn boundary still reports its newest sequence.
*/
function logPosition(window) {
	if (window === void 0) return {
		boundary: void 0,
		seq: -1
	};
	let boundary;
	let boundarySeq = -1;
	let seq = -1;
	for (const entry of window.entries) {
		if (entry.type === "transient") continue;
		const event = entry.event;
		if (event === void 0) continue;
		if (!Number.isSafeInteger(event.seq) || event.seq < 0) continue;
		if (event.seq > seq) seq = event.seq;
		if (event.type !== "turn/start" && event.type !== "turn/end") continue;
		if (event.seq <= boundarySeq) continue;
		const turn = announcedTurn(event.data);
		if (turn === void 0) continue;
		boundary = {
			turn,
			open: event.type === "turn/start"
		};
		boundarySeq = event.seq;
	}
	return {
		boundary,
		seq
	};
}

//#endregion
//#region src/client/summary-source.ts
/** The absent view a source without a binding still serves. */
const NO_SUMMARY = { summary: void 0 };
/**
* Whether two summaries say the same thing.
*
* Each read decodes a fresh JSON object, so identity alone would report a change
* on every re-read of an unchanged turn. Comparing by value keeps the snapshot
* identity — and with it the component's render and its expanded state — stable
* while the numbers stand still.
* @param left - the standing summary, or undefined.
* @param right - the freshly read summary, or undefined.
* @returns whether the bar has nothing new to draw.
*/
function sameSummary(left, right) {
	if (left === right) return true;
	if (left === void 0 || right === void 0) return false;
	if (left.turn !== right.turn || left.total !== right.total || left.added !== right.added || left.deleted !== right.deleted) return false;
	if (left.files.length !== right.files.length) return false;
	return left.files.every((file, index) => {
		const other = right.files[index];
		return other !== void 0 && file.path === other.path && file.display === other.display && file.added === other.added && file.deleted === other.deleted && file.binary === other.binary;
	});
}
/**
* The read key for one log position.
*
* The newest durable sequence is part of the key, so any new activity — the
* `tool/result` the host measures after, a `turn/end`, another `turn/start` —
* invalidates the standing read. The turn's own number and whether it is open
* are in it too, so a read can never be answered by a different turn's numbers.
* @param position - the Session's log position.
* @returns an opaque key.
*/
function readKey(position) {
	const boundary = position.boundary;
	if (boundary === void 0) return "latest";
	return `${boundary.open ? "open" : "closed"}:${String(boundary.turn)}:${String(position.seq)}`;
}
/**
* Mint the source for one Session.
*
* Every read is aimed at the Session this source was minted for, so switching
* Sessions swaps the source rather than the data underneath it.
* @param sessionId - the Session the dock entry is mounted in.
* @param binding - that Session's client binding, or undefined when it has none.
* @param read - the request implementation; defaults to the page's `fetch`.
* @returns the observable source the dock entry injects as `useSummary`.
*/
function createDiffSummarySource(sessionId, binding, read = (url, signal$1) => fetch(url, { signal: signal$1 })) {
	let snapshot = NO_SUMMARY;
	let signal;
	let generation = new AbortController();
	let reading = false;
	let dirty = false;
	const listeners = /* @__PURE__ */ new Set();
	/**
	* Publish a settled state, keeping snapshot identity stable while nothing
	* changed — identity is what `useSyncExternalStore` and the component's
	* expanded state both key on.
	*/
	const publish = (next) => {
		if (sameSummary(snapshot.summary, next)) return;
		snapshot = { summary: next };
		for (const listener of [...listeners]) listener();
	};
	/** Run one read and publish its outcome, unless a newer signal replaced it. */
	const load = async (key, turn) => {
		const scope = generation;
		let next;
		try {
			const response = await read(summaryUrl(sessionId, turn), scope.signal);
			if (scope.signal.aborted) return;
			if (response.status === 204) {
				publish(void 0);
				return;
			}
			if (!response.ok) return;
			const value = await response.json();
			next = isChangeSummary(value) ? value : void 0;
		} catch {
			return;
		}
		if (scope.signal.aborted || signal !== key) return;
		publish(next);
	};
	/**
	* Read whenever the Session's log has moved.
	*
	* A turn produces many durable events, so this coalesces instead of queueing:
	* one read is in flight at a time, and activity during a read marks the source
	* dirty, which re-reads once as soon as that read settles. The guards inside
	* {@link load} — a superseded key, or a generation a refresh abandoned — are
	* what keep a stale answer from landing.
	*/
	const pump = async () => {
		if (reading) {
			dirty = true;
			return;
		}
		reading = true;
		try {
			for (;;) {
				dirty = false;
				const position = logPosition(binding?.eventSource.getSnapshot());
				const key = readKey(position);
				if (key !== signal) {
					signal = key;
					await load(key, position.boundary?.turn);
				}
				if (!dirty) break;
			}
		} finally {
			reading = false;
		}
	};
	const observe = () => {
		pump().catch(() => {});
	};
	binding?.eventSource.subscribe(observe);
	observe();
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		refresh: () => {
			generation.abort();
			generation = new AbortController();
			signal = void 0;
			observe();
		}
	};
}

//#endregion
//#region src/client/index.ts
/** Stable Loader identity, matching the host half's plugin row. */
const name = PLUGIN_NAME;
/** Slot registry, Session bindings, and this plugin's copy. */
const inject = [
	"slots",
	"sessions",
	"locale"
];
/** The source name injected into the entry; the renderer exposes it as `useSummary`. */
const SUMMARY_SOURCE_NAME = "summary";
/**
* Build the session-bound source one mounted bar reads through.
* @param ctx - client root context.
* @param sessionId - the Session the entry is mounted in.
* @param read - the request implementation; omitted in production.
* @returns the observable source handed to the bar as `useSummary`.
*/
function createSource(ctx, sessionId, read) {
	return createDiffSummarySource(sessionId, ctx.sessions.binding(sessionId), read);
}
/**
* Client plugin body: install the stylesheet, register the dictionaries, and
* register the dock entry under the plugin's own id.
* @param ctx - client root context.
*/
function apply(ctx) {
	installStyles();
	ctx.effect(() => ctx.locale.register(NS, {
		en,
		zh
	}), "chat-diff-summary-legacy: dictionaries");
	const sources = /* @__PURE__ */ new Set();
	ctx.effect(() => {
		const off = ctx.on("connection/reset", () => {
			for (const source of [...sources]) source.refresh();
		});
		return () => {
			off();
			sources.clear();
		};
	}, "chat-diff-summary-legacy: connection resets");
	ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
		name: "conversation.input.dock",
		id: ENTRY_ID,
		order: 30,
		locale: NS,
		inject: (sessionId) => {
			const source = createSource(ctx, sessionId);
			sources.add(source);
			return { hooks: { [SUMMARY_SOURCE_NAME]: source } };
		}
	}, ChatDiffSummary));
}

//#endregion
exports.ChatDiffSummary = ChatDiffSummary;
exports.ENTRY_ID = ENTRY_ID;
exports.SUMMARY_SOURCE_NAME = SUMMARY_SOURCE_NAME;
exports.apply = apply;
exports.createSource = createSource;
exports.inject = inject;
exports.name = name;
return module.exports; } });