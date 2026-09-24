import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

//#region src/git.ts
/** Per-command bounds for the tracked repository's git calls. */
const GIT_TIMEOUT_MS = 3e4;
/** In-memory stdout cap for one git call. */
const GIT_MAX_BYTES = 8 * 1024 * 1024;
/** Environment entries carried into every git call; everything else is scrubbed. */
const PASSTHROUGH = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TZ",
	"SystemRoot",
	"ComSpec",
	"PATHEXT",
	"SystemDrive"
];
/** Environment entries that must never leak into a git call from the host process. */
const SCRUBBED = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_CEILING_DIRECTORIES",
	"GIT_EXTERNAL_DIFF",
	"GIT_PAGER",
	"GIT_EDITOR",
	"GIT_NAMESPACE",
	"GIT_SSH_COMMAND"
];
/** Run one program with a hard timeout, a stdout cap, and abort support. */
const runCommand = (request) => new Promise((settle, fail) => {
	const child = spawn(request.file, [...request.args], {
		cwd: request.cwd,
		env: request.env,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		windowsHide: true
	});
	const out = [];
	const err = [];
	let outBytes = 0;
	let done = false;
	const finish = (result) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		request.signal.removeEventListener("abort", abort);
		if (result instanceof Error) fail(result);
		else settle(result);
	};
	const abort = () => {
		child.kill("SIGKILL");
		finish(/* @__PURE__ */ new Error(`aborted: ${request.file} ${request.args.join(" ")}`));
	};
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish(/* @__PURE__ */ new Error(`timed out after ${String(request.timeoutMs)}ms: ${request.file} ${request.args.join(" ")}`));
	}, request.timeoutMs);
	if (request.signal.aborted) {
		abort();
		return;
	}
	request.signal.addEventListener("abort", abort, { once: true });
	child.stdout.on("data", (chunk) => {
		outBytes += chunk.length;
		if (outBytes <= request.maxBytes) out.push(chunk);
	});
	child.stderr.on("data", (chunk) => {
		err.push(chunk);
	});
	child.on("error", (error) => {
		finish(error);
	});
	child.on("close", (code) => {
		if (outBytes > request.maxBytes) {
			finish(/* @__PURE__ */ new Error(`output exceeded ${String(request.maxBytes)} bytes: ${request.file} ${request.args.join(" ")}`));
			return;
		}
		finish({
			exitCode: code,
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(err).toString("utf8")
		});
	});
});
/** Build the scrubbed environment one git call runs under. */
function gitEnvironment(inherited = process.env) {
	const env = {};
	for (const name$1 of PASSTHROUGH) {
		const value = inherited[name$1];
		if (value !== void 0 && value !== "") env[name$1] = value;
	}
	for (const name$1 of SCRUBBED) delete env[name$1];
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	return env;
}
/** Well-known install locations, tried after `PATH`; a GUI-launched host has a minimal `PATH`. */
const GIT_CANDIDATES = [
	"/usr/bin/git",
	"/usr/local/bin/git",
	"/opt/homebrew/bin/git",
	"/opt/local/bin/git",
	"git"
];
/** Resolve one usable `git`, or null when the host has none. */
async function resolveGit(runner, env, signal) {
	if (process.platform === "darwin") {
		if ((await runner({
			file: "/usr/bin/xcode-select",
			args: ["-p"],
			cwd: process.cwd(),
			env: {
				...env,
				PATH: env.PATH ?? ""
			},
			timeoutMs: 5e3,
			maxBytes: 4096,
			signal
		}).catch(() => ({
			exitCode: null,
			stdout: "",
			stderr: ""
		}))).exitCode !== 0) return null;
	}
	for (const candidate of GIT_CANDIDATES) {
		const probe = await runner({
			file: candidate,
			args: ["--version"],
			cwd: process.cwd(),
			env: {
				...env,
				PATH: env.PATH ?? ""
			},
			timeoutMs: 1e4,
			maxBytes: 4096,
			signal
		}).catch(() => void 0);
		if (probe !== void 0 && probe.exitCode === 0 && /^git version /u.test(probe.stdout)) return candidate;
	}
	return null;
}
/** Whether `child` is `parent` or lies below it, on canonical paths. */
function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
/** Convert an OS-relative path to the slash form git pathspecs use. */
function toPosix(path) {
	return sep === "/" ? path : path.split(sep).join("/");
}
/**
* Locate the repository enclosing a working directory and prepare the private
* directory its snapshots write to.
* @param runner - the injected subprocess runner.
* @param executable - the resolved git executable.
* @param env - the scrubbed environment.
* @param cwd - absolute Session working directory.
* @param scratch - yields the private directory; called only once a repository is found.
* @param signal - cancellation.
* @returns the located repository, or null when `cwd` is outside one.
*/
async function locateWorkspace(runner, executable, env, cwd, scratch, signal) {
	const found = await runner({
		file: executable,
		args: [
			"rev-parse",
			"--show-toplevel",
			"--absolute-git-dir",
			"--git-path",
			"objects"
		],
		cwd,
		env,
		timeoutMs: 1e4,
		maxBytes: 64 * 1024,
		signal
	});
	if (found.exitCode !== 0) return null;
	const [root, gitDir, repositoryObjects] = found.stdout.split("\n").slice(0, 3).map((line) => resolve(cwd, line));
	if (root === void 0 || gitDir === void 0 || repositoryObjects === void 0) return null;
	const objects = join(await scratch(), "objects");
	await mkdir(objects, { recursive: true });
	const canonical = await realpath(join(objects, ".."));
	return {
		root,
		gitDir,
		scratch: canonical,
		env: {
			...env,
			GIT_OBJECT_DIRECTORY: objects,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: repositoryObjects
		},
		excludes: isInside(root, canonical) ? [toPosix(relative(root, canonical))] : []
	};
}
/**
* Write the complete work tree — modified, deleted, untracked, but not ignored
* files — as a tree object in the private object store.
*
* The private index is seeded from HEAD rather than copied from the repository's
* index, and that distinction is load-bearing. A copied index carries the
* repository's stat cache, and `git add` is allowed to trust a cached stat: when
* an edit preserves a file's size and the copy's own mtime lands after the
* file's, git skips re-hashing and writes a tree holding the *previous* content.
* Measured on this machine, that silently produced a stale tree in 2 of 40
* same-size edits — a turn whose change went unreported. `read-tree` populates
* entries with no stat data, so `git add` must hash every path; the same probe
* scored 0 of 40. `tests/git.spec.ts` keeps that probe as a regression guard.
*
* @param runner - the injected subprocess runner.
* @param executable - the resolved git executable.
* @param workspace - the addressed repository.
* @param index - absolute path this snapshot's private index is written to.
* @param excludes - work-tree paths the snapshot must skip.
* @param signal - cancellation.
* @returns the tree object id, or null when git refused the snapshot.
*/
async function snapshotTree(runner, executable, workspace, index, excludes, signal) {
	await mkdir(join(index, ".."), { recursive: true });
	await rm(index, { force: true });
	const env = {
		...workspace.env,
		GIT_INDEX_FILE: index
	};
	if ((await runner({
		file: executable,
		args: ["read-tree", "HEAD"],
		cwd: workspace.root,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: GIT_MAX_BYTES,
		signal
	})).exitCode !== 0) await rm(index, { force: true });
	const added = await runner({
		file: executable,
		args: [
			"add",
			"--all",
			"--ignore-errors",
			...excludes.length === 0 ? [] : [
				"--",
				".",
				...excludes.map((path) => `:(exclude)${path}`)
			]
		],
		cwd: workspace.root,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: GIT_MAX_BYTES,
		signal
	});
	if (added.exitCode !== 0 && added.exitCode !== 1) return null;
	const written = await runner({
		file: executable,
		args: ["write-tree"],
		cwd: workspace.root,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: 64 * 1024,
		signal
	});
	if (written.exitCode !== 0) return null;
	const tree = written.stdout.trim();
	return /^[0-9a-f]{40,64}$/u.test(tree) ? tree : null;
}
/**
* Parse the NUL-terminated records of `git diff-tree -r -M -z --numstat`. A
* rename record carries an empty path followed by the old and the new path.
* @param output - the complete stdout of that call.
* @returns records in git's output order.
* @throws when a record is malformed, which means the output was truncated.
*/
function parseNumstat(output) {
	const queue = output.split("\0");
	if (queue.at(-1) !== "") throw new Error("numstat output is not NUL-terminated");
	queue.pop();
	const changes = [];
	while (queue.length > 0) {
		const record = queue.shift() ?? "";
		const first = record.indexOf("	");
		const second = first < 0 ? -1 : record.indexOf("	", first + 1);
		if (second < 0) throw new Error(`malformed numstat record: ${JSON.stringify(record)}`);
		const added = record.slice(0, first);
		const deleted = record.slice(first + 1, second);
		let path = record.slice(second + 1);
		if (path === "") {
			queue.shift();
			const renamed = queue.shift();
			if (renamed === void 0) throw new Error("malformed numstat rename record");
			path = renamed;
		}
		const binary = added === "-";
		changes.push({
			path,
			added: binary ? 0 : Number(added),
			deleted: binary ? 0 : Number(deleted),
			binary
		});
	}
	return changes;
}
/**
* Per-file line counts between two snapshot trees, with renames detected.
* @param runner - the injected subprocess runner.
* @param executable - the resolved git executable.
* @param workspace - the addressed repository.
* @param before - turn-start tree id.
* @param after - turn-end tree id.
* @param signal - cancellation.
* @returns changed files relative to the repository root.
* @throws when git fails or the output exceeded the cap.
*/
async function diffTrees(runner, executable, workspace, before, after, signal) {
	if (before === after) return [];
	const result = await runner({
		file: executable,
		args: [
			"diff-tree",
			"-r",
			"-M",
			"-z",
			"--numstat",
			before,
			after
		],
		cwd: workspace.root,
		env: workspace.env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: GIT_MAX_BYTES,
		signal
	});
	if (result.exitCode !== 0) throw new Error(`git diff-tree failed: ${result.stderr.trim()}`);
	return parseNumstat(result.stdout);
}
/** Create one private scratch directory outside the work tree, canonicalized. */
async function createScratch(label) {
	return realpath(await mkdtemp(join(tmpdir(), `${label}-`)));
}
/** Remove one private scratch directory and everything git wrote into it. */
async function removeScratch(scratch) {
	await rm(scratch, {
		recursive: true,
		force: true
	});
}

//#endregion
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
/** Authenticated route this plugin owns below `/api`; a third-party path, never a shipped one. */
const SUMMARY_PATH = "/api/chat-diff-summary-legacy.summary";
/** How many files one summary carries before the list is truncated. */
const MAX_FILES = 200;
/** How many completed turns one Session keeps, so a briefly lagging client still finds its turn. */
const MAX_RETAINED_TURNS = 8;

//#endregion
//#region src/tracker.ts
/** How long a route read waits for a turn whose measurement is still in flight. */
const SUMMARY_WAIT_MS = 2e4;
/**
* Shortest gap between two in-turn measurements of one Session.
*
* A turn produces a tool result per mutating call, and every measurement is a
* real `git add` over the work tree. The interval keeps a burst of calls from
* walking the tree once each while still making the bar keep up with a working
* agent; the turn's own end always measures, so a change dropped by this bound is
* only ever late, never missing.
*/
const PROGRESS_INTERVAL_MS = 400;
/** A summary for a turn whose changes could not be computed; it draws as nothing. */
function emptySummary(turn) {
	return {
		turn,
		files: [],
		total: 0,
		added: 0,
		deleted: 0
	};
}
/** The basename of a slash-separated path. */
function basename(path) {
	const cut = path.lastIndexOf("/");
	return cut < 0 ? path : path.slice(cut + 1);
}
/**
* Build one turn's wire summary from the raw diff.
* @param turn - the summarized turn.
* @param changes - per-file counts relative to the repository root.
* @returns the summary, with `files` capped and `total` complete.
*/
function summarize(turn, changes) {
	const ordered = [...changes].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
	return {
		turn,
		files: ordered.slice(0, MAX_FILES).map((change) => ({
			path: change.path,
			display: basename(change.path),
			added: change.added,
			deleted: change.deleted,
			...change.binary ? { binary: true } : {}
		})),
		total: ordered.length,
		added: ordered.reduce((total, change) => total + change.added, 0),
		deleted: ordered.reduce((total, change) => total + change.deleted, 0)
	};
}
/** The real engine: git plumbing writing only into the Session's scratch directory. */
function createGitEngine(runner, executable, environment) {
	return {
		locate: (cwd, scratch, signal) => locateWorkspace(runner, executable, environment, cwd, () => Promise.resolve(scratch), signal),
		snapshot: (workspace, label, signal) => snapshotTree(runner, executable, workspace, `${workspace.scratch}/index-${label}`, workspace.excludes, signal),
		diff: (workspace, before, after, signal) => diffTrees(runner, executable, workspace, before, after, signal),
		createScratch: () => createScratch("dsh-chat-diff-legacy"),
		removeScratch: (scratch) => removeScratch(scratch)
	};
}
/** Report whether a Session mixes top-level and delegated turns. */
function isTopLevel(cwd, origin, depth) {
	if (cwd === void 0 || cwd === "") return false;
	return origin !== "subagent" && depth <= 0;
}
/** One plugin instance's tracker over every live Session. */
var TurnTracker = class {
	sessions = /* @__PURE__ */ new Map();
	/**
	* @param engine - resolves the snapshot engine once, or null when this host has no git.
	* @param logger - host logger for contained failures.
	* @param lifetime - aborts every in-flight git call on plugin disposal.
	*/
	constructor(engine, logger, lifetime) {
		this.engine = engine;
		this.logger = logger;
		this.lifetime = lifetime;
	}
	/**
	* Open a turn: reset the baseline and queue its snapshot.
	*
	* The snapshot is asynchronous because it is a real git call; the host gates
	* tool dispatch on {@link settle}, so nothing can mutate the work tree between
	* the turn's first tool call and the baseline being written.
	* @param sessionId - the Session whose turn opened.
	* @param cwd - the Session working directory, absent for a Session without one.
	* @param origin - the Session's coarse product origin.
	* @param delegationDepth - how deep below a top-level Session this one sits.
	* @param turn - the turn number from the `turn/start` event.
	*/
	beginTurn(sessionId, cwd, origin, delegationDepth, turn) {
		if (!isTopLevel(cwd, origin, delegationDepth)) return;
		const record = this.recordFor(sessionId);
		record.turn = turn;
		record.baseline = null;
		this.enqueue(record, async (signal) => {
			const engine = await this.engine();
			if (engine === null) return;
			const workspace = await this.workspaceFor(engine, record, cwd, signal);
			if (workspace === null) return;
			const tree = await engine.snapshot(workspace, "base", signal);
			if (record.turn === turn) record.baseline = tree;
		});
	}
	/**
	* Re-measure the open turn without closing it, so the bar can follow a turn
	* while it runs rather than only once it ends.
	*
	* The measurement is the same baseline-to-work-tree diff the turn's end will
	* take; it simply replaces the turn's stored summary early. Calls are coalesced
	* two ways: one measurement is in flight at a time, and two measurements of the
	* same Session are never closer together than {@link PROGRESS_INTERVAL_MS}.
	* @param sessionId - the Session whose turn is still open.
	*/
	progress(sessionId) {
		const record = this.sessions.get(sessionId);
		if (record === void 0 || record.turn < 1) return;
		if (record.baseline === null || record.progressQueued) return;
		const now = Date.now();
		if (record.lastMeasuredAt !== 0 && now - record.lastMeasuredAt < PROGRESS_INTERVAL_MS) return;
		record.progressQueued = true;
		this.enqueue(record, async (signal) => {
			try {
				const turn = record.turn;
				const baseline = record.baseline;
				if (baseline === null) return;
				const engine = await this.engine();
				if (engine === null) return;
				const workspace = record.workspace ?? null;
				if (workspace === null) return;
				const tree = await engine.snapshot(workspace, "live", signal);
				if (tree === null) return;
				const changes = await engine.diff(workspace, baseline, tree, signal);
				if (record.turn !== turn || record.baseline !== baseline) return;
				this.remember(record, summarize(turn, changes));
			} finally {
				record.progressQueued = false;
				record.lastMeasuredAt = Date.now();
			}
		});
	}
	/**
	* Close a turn: queue the end snapshot, its diff, and the stored summary.
	*
	* The previous turn's summary stays readable while this one is being
	* computed, so a new turn never leaves the bar in a half-drawn state; the
	* summary is replaced, not cleared, the moment the diff is known.
	* @param sessionId - the Session whose turn closed.
	* @param turn - the turn number from the `turn/end` event.
	*/
	endTurn(sessionId, turn) {
		const record = this.sessions.get(sessionId);
		if (record === void 0 || record.turn !== turn) return;
		record.lastMeasuredAt = 0;
		this.enqueue(record, async (signal) => {
			if (record.turn !== turn) return;
			const workspace = record.workspace ?? null;
			const baseline = record.baseline;
			if (workspace === null || baseline === null) {
				this.remember(record, emptySummary(turn));
				return;
			}
			const engine = await this.engine();
			if (engine === null) {
				this.remember(record, emptySummary(turn));
				return;
			}
			const end = await engine.snapshot(workspace, "end", signal);
			if (end === null) {
				this.remember(record, emptySummary(turn));
				return;
			}
			this.remember(record, summarize(turn, await engine.diff(workspace, baseline, end, signal)));
		});
	}
	/**
	* Resolve once this Session has no queued snapshot work.
	*
	* The host's tool gate awaits this before dispatching a call, which is what
	* keeps the baseline ahead of the turn's first mutation.
	* @param sessionId - the Session about to run a tool.
	* @returns when every queued snapshot, diff, and record has settled.
	*/
	async settle(sessionId) {
		await this.sessions.get(sessionId)?.chain;
	}
	/**
	* Read one Session's summary, waiting for a turn whose measurement is still
	* in flight.
	*
	* `turn/end` reaches this tracker synchronously, but its end snapshot and diff
	* are real git calls. A browser that observes the turn boundary and asks
	* immediately would otherwise be told "nothing" for a turn that is merely
	* still being measured — and would have no reason to ask again. Waiting for
	* the Session's queued work closes that race at the source, so one request
	* still answers the question.
	* @param sessionId - the Session to read.
	* @param turn - a specific turn, or omitted for the newest completed one.
	* @param waitMs - how long to wait for a measurement already under way.
	* @returns the summary, or undefined when this Session has none.
	*/
	async completed(sessionId, turn, waitMs = SUMMARY_WAIT_MS) {
		const record = this.sessions.get(sessionId);
		if (record === void 0) return this.summary(sessionId, turn);
		if (!(turn === void 0 ? record.summaries.size === 0 : record.turn === turn)) return this.summary(sessionId, turn);
		await Promise.race([record.chain, new Promise((resolve$1) => setTimeout(resolve$1, waitMs))]);
		return this.summary(sessionId, turn);
	}
	/**
	* Read one Session's summary as it stands right now.
	* @param sessionId - the Session to read.
	* @param turn - a specific turn, or omitted for the newest completed one.
	* @returns the summary, or undefined when this Session has none.
	*/
	summary(sessionId, turn) {
		const record = this.sessions.get(sessionId);
		if (record === void 0) return void 0;
		if (turn !== void 0) return record.summaries.get(turn);
		let newest;
		for (const [candidate, summary] of record.summaries) if (newest === void 0 || candidate > newest.turn) newest = summary;
		return newest;
	}
	/** Forget one Session and delete everything the tracker wrote for it. */
	async disposeSession(sessionId) {
		const record = this.sessions.get(sessionId);
		if (record === void 0) return;
		this.sessions.delete(sessionId);
		await record.chain;
		if (record.scratch === void 0) return;
		await (await this.engine())?.removeScratch(record.scratch).catch(() => {});
	}
	/** Forget every Session; used on plugin disposal. */
	async dispose() {
		await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)));
	}
	/** The Session's record, created on first sight. */
	recordFor(sessionId) {
		const existing = this.sessions.get(sessionId);
		if (existing !== void 0) return existing;
		const record = {
			sessionId,
			chain: Promise.resolve(),
			scratch: void 0,
			workspace: void 0,
			turn: 0,
			baseline: null,
			progressQueued: false,
			lastMeasuredAt: 0,
			summaries: /* @__PURE__ */ new Map()
		};
		this.sessions.set(sessionId, record);
		return record;
	}
	/** Append one step to the Session's chain; a failing step is logged, never rethrown. */
	enqueue(record, step) {
		record.chain = record.chain.then(async () => {
			if (this.lifetime.aborted) return;
			try {
				await step(this.lifetime);
			} catch (error) {
				if (this.lifetime.aborted) return;
				this.logger.warn(`chat-diff-summary-legacy: session "${record.sessionId}": ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	}
	/** Store one summary, keeping only the newest {@link MAX_RETAINED_TURNS} turns. */
	remember(record, summary) {
		record.summaries.set(summary.turn, summary);
		while (record.summaries.size > MAX_RETAINED_TURNS) {
			const oldest = Math.min(...record.summaries.keys());
			record.summaries.delete(oldest);
		}
	}
	/** Locate the Session's repository once, retrying while no repository exists yet. */
	async workspaceFor(engine, record, cwd, signal) {
		if (record.workspace !== void 0 && record.workspace !== null) return record.workspace;
		record.scratch ??= await engine.createScratch();
		const located = await engine.locate(cwd, record.scratch, signal);
		record.workspace = located;
		return located;
	}
};
/** Resolve the real git engine once, or null when this host has no usable git. */
function createEngineProvider(runner, logger, signal) {
	let resolved;
	return () => {
		resolved ??= (async () => {
			const environment = gitEnvironment();
			const executable = await resolveGit(runner, environment, signal);
			if (executable === null) {
				logger.warn("chat-diff-summary-legacy: git is unavailable; change summaries are disabled");
				return null;
			}
			return createGitEngine(runner, executable, environment);
		})();
		return resolved;
	};
}

//#endregion
//#region src/index.ts
/** Stable Loader identity; the browser half declares the same name. */
const name = PLUGIN_NAME;
/** Services required before the summary route can be registered. */
const inject = ["connection"];
/** A non-negative turn number, or undefined when the query is absent. */
function turnCoordinate(raw) {
	if (raw === null) return void 0;
	if (!/^\d+$/u.test(raw)) return NaN;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= 1 ? value : NaN;
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
async function handleSummary(tracker, request) {
	const query = new URL(request.url).searchParams;
	const sessionId = query.get("sessionId");
	if (sessionId === null || sessionId === "") return new Response("Invalid change summary coordinates.", { status: 400 });
	const turn = turnCoordinate(query.get("turn"));
	if (turn !== void 0 && Number.isNaN(turn)) return new Response("Invalid change summary coordinates.", { status: 400 });
	const summary = await tracker.completed(sessionId, turn);
	if (summary === void 0) return new Response(null, {
		status: 204,
		headers: { "cache-control": "no-store" }
	});
	return Response.json(summary, { headers: { "cache-control": "no-store" } });
}
/** The turn number one `turn/start` or `turn/end` event carries, or undefined when malformed. */
function eventTurn(event) {
	const data = event.data;
	if (typeof data !== "object" || data === null) return void 0;
	const turn = data.turn;
	return Number.isSafeInteger(turn) && turn >= 1 ? turn : void 0;
}
/**
* Register turn tracking and the summary route.
* @param ctx - host context carrying `connection`.
*/
function apply(ctx) {
	const lifetime = new AbortController();
	const tracker = new TurnTracker(createEngineProvider(runCommand, ctx.logger, lifetime.signal), ctx.logger, lifetime.signal);
	ctx.effect(() => async () => {
		lifetime.abort();
		await tracker.dispose();
	}, "chat-diff-summary-legacy: tracker");
	ctx.on("session/event", (session, event) => {
		if (event.type === "tool/result") {
			tracker.progress(session.id);
			return;
		}
		const turn = eventTurn(event);
		if (turn === void 0) return;
		if (event.type === "turn/start") {
			tracker.beginTurn(session.id, session.header.cwd, session.header.origin, session.header.delegationDepth ?? 0, turn);
			return;
		}
		if (event.type === "turn/end") tracker.endTurn(session.id, turn);
	}, { global: true });
	ctx.on("session/disposed", (session) => {
		tracker.disposeSession(session.id);
	}, { global: true });
	ctx.on("tools/pre-execute", async (exec, next) => {
		try {
			const sessionId = exec.agent?.session.id;
			if (typeof sessionId === "string") await tracker.settle(sessionId);
		} catch (error) {
			ctx.logger.warn(`chat-diff-summary-legacy: change gate failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return next();
	}, { global: true });
	ctx.connection.fetch.register({
		path: SUMMARY_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: (request) => handleSummary(tracker, request)
	});
}

//#endregion
export { apply, handleSummary, inject, name };