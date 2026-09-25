import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

//#region src/git.ts
/** Per-command bounds for the tracked repository's git calls. */
const GIT_TIMEOUT_MS = 3e4;
/** In-memory stdout cap for one git call. */
const GIT_MAX_BYTES = 8 * 1024 * 1024;
/**
* Bound for the single pass that mints a synthetic workspace's first tree.
*
* That pass reads every accepted file once, so it is the only git call in this
* plugin whose cost scales with the whole directory rather than with a turn:
* measured on a 1.7 GB / 28k-file directory with the default excludes, it took
* 36.7 s. Every later pass re-reads only what changed. The larger bound exists so
* a big directory is allowed to finish instead of being abandoned at 30 s.
*/
const GIT_WARMUP_TIMEOUT_MS = 10 * 6e4;
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
/** A diagnostics sink that reports nothing; the default for direct calls. */
const SILENT_DIAGNOSTICS = {
	failed: () => {},
	step: () => {}
};
/** Longest stderr fragment any diagnostic carries. */
const STDERR_LIMIT = 400;
/** Trim one diagnostic fragment to a single bounded line. */
function trimDiagnostic(text, limit = STDERR_LIMIT) {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}
/** Render one failure as the line the host log carries. */
function describeFailure(event) {
	const parts = [`${event.operation} failed`];
	if (event.sessionId !== void 0) parts.push(`session=${event.sessionId}`);
	if (event.root !== void 0) parts.push(`root=${event.root}`);
	if (event.attempt !== void 0) parts.push(`attempt=${String(event.attempt)}`);
	if (event.exitCode !== void 0) parts.push(`exit=${String(event.exitCode)}`);
	parts.push(`elapsed=${String(event.elapsedMs)}ms`);
	if (event.detail !== void 0) parts.push(`detail=${event.detail}`);
	if (event.stderr !== void 0 && event.stderr !== "") parts.push(`stderr=${trimDiagnostic(event.stderr)}`);
	return `chat-diff-summary-legacy: ${parts.join(" ")}`;
}
/** Render one finished step as the line the host log carries. */
function describeStep(event) {
	const parts = [`${event.operation} finished`];
	if (event.sessionId !== void 0) parts.push(`session=${event.sessionId}`);
	if (event.root !== void 0) parts.push(`root=${event.root}`);
	if (event.attempt !== void 0) parts.push(`attempt=${String(event.attempt)}`);
	parts.push(`elapsed=${String(event.elapsedMs)}ms`);
	if (event.detail !== void 0) parts.push(`detail=${event.detail}`);
	return `chat-diff-summary-legacy: ${parts.join(" ")}`;
}
/** Report one failed git step, with the exit code and the words git used. */
function reportFailure(diagnostics, context, operation, root, startedAt, result, detail) {
	diagnostics.failed({
		operation,
		elapsedMs: Date.now() - startedAt,
		...root === void 0 ? {} : { root },
		...context,
		...result === void 0 ? {} : {
			exitCode: result.exitCode,
			stderr: result.stderr
		},
		...detail === void 0 ? {} : { detail }
	});
}
/** Report one finished git step together with what it cost. */
function reportStep(diagnostics, context, operation, root, startedAt, detail) {
	diagnostics.step({
		operation,
		elapsedMs: Date.now() - startedAt,
		...root === void 0 ? {} : { root },
		...context,
		...detail === void 0 ? {} : { detail }
	});
}
/** Report an operation that threw instead of returning an exit code. */
function reportThrown(diagnostics, context, operation, root, startedAt, error) {
	const detail = error instanceof Error ? error.message : String(error);
	const timedOut = /timed out/iu.test(detail);
	reportFailure(diagnostics, context, operation, root, startedAt, void 0, /aborted/iu.test(detail) ? "aborted (workspace disposed)" : timedOut ? `warmup timeout: ${detail}` : detail);
	return detail;
}
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
* @param diagnostics - where step costs and failures are reported.
* @param context - the Session (and attempt) this call belongs to.
* @returns the located repository, or null when `cwd` is outside one.
*/
async function locateWorkspace(runner, executable, env, cwd, scratch, signal, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	const started = Date.now();
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
	if (found.exitCode !== 0) {
		reportStep(diagnostics, context, "rev-parse --show-toplevel (repository probe)", cwd, started, `exit=${String(found.exitCode)}`);
		return null;
	}
	const [root, gitDir, repositoryObjects] = found.stdout.split("\n").slice(0, 3).map((line) => resolve(cwd, line));
	if (root === void 0 || gitDir === void 0 || repositoryObjects === void 0) {
		reportFailure(diagnostics, context, "rev-parse --show-toplevel (repository probe)", cwd, started, found, "the answer did not name a root, a git directory and an object store");
		return null;
	}
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
* @param diagnostics - where step costs and failures are reported.
* @param context - the Session (and attempt) this call belongs to.
* @returns the tree object id, or null when git refused the snapshot.
*/
async function snapshotTree(runner, executable, workspace, index, excludes, signal, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	await mkdir(join(index, ".."), { recursive: true });
	await rm(index, { force: true });
	const env = {
		...workspace.env,
		GIT_INDEX_FILE: index
	};
	const seeded = await runner({
		file: executable,
		args: ["read-tree", "HEAD"],
		cwd: workspace.root,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: GIT_MAX_BYTES,
		signal
	});
	if (seeded.exitCode !== 0) {
		reportStep(diagnostics, context, "read-tree HEAD (no commit yet)", workspace.root, Date.now(), `exit=${String(seeded.exitCode)}`);
		await rm(index, { force: true });
	}
	const pathspec = excludes.length === 0 ? [] : [
		"--",
		".",
		...excludes.map((path) => `:(exclude)${path}`)
	];
	const addStarted = Date.now();
	const added = await runner({
		file: executable,
		args: [
			"add",
			"--all",
			"--ignore-errors",
			...pathspec
		],
		cwd: workspace.root,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: GIT_MAX_BYTES,
		signal
	});
	if (added.exitCode !== 0 && added.exitCode !== 1) {
		reportFailure(diagnostics, context, "add --all", workspace.root, addStarted, added);
		return null;
	}
	const written = await runner({
		file: executable,
		args: ["write-tree"],
		cwd: workspace.root,
		env,
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: 64 * 1024,
		signal
	});
	if (written.exitCode !== 0) {
		reportFailure(diagnostics, context, "write-tree", workspace.root, addStarted, written);
		return null;
	}
	const tree = written.stdout.trim();
	if (!/^[0-9a-f]{40,64}$/u.test(tree)) {
		reportFailure(diagnostics, context, "write-tree", workspace.root, addStarted, written, "the answer was not a tree id");
		return null;
	}
	return tree;
}
/**
* Ignore patterns a synthetic workspace starts with.
*
* Nothing else can supply them: the directory has no repository, so it has no
* ignore rules written for a repository root and no store to hold them. A
* `.gitignore` found *inside* the directory still applies, because git resolves
* those through the private repository too; this list is added on top of it. A
* user-level `core.excludesFile` applies only where git can find the user's own
* configuration — on POSIX, where `HOME` survives into these calls, and not on
* Windows, where this plugin's scrubbed environment carries no profile path.
*
* The set is about cost rather than taste. The first pass reads every file it
* accepts, so it skips source-control stores, dependency trees, build output,
* and the archives and binaries that carry no line counts to report in the first
* place. The README lists the same patterns for readers.
*/
const SYNTHETIC_EXCLUDES = [
	"# Source-control stores and dependency trees.",
	".git/",
	".hg/",
	".svn/",
	"node_modules/",
	"# Build output and caches.",
	"dist/",
	"build/",
	"out/",
	"target/",
	"coverage/",
	"__pycache__/",
	".venv/",
	"venv/",
	"# Archives and binaries: no line counts, and they dominate the first pass.",
	"*.apk",
	"*.zip",
	"*.7z",
	"*.rar",
	"*.exe",
	"*.dll",
	"*.so",
	"*.dylib",
	"*.iso",
	"*.dmg",
	"*.msi"
].join("\n") + "\n";
/**
* Mint a private workspace for a directory that no repository encloses.
*
* The result is a real repository, but not one the user owns: `git init` creates
* it inside `scratch`, every later call addresses it through `GIT_DIR` and
* `GIT_WORK_TREE`, and the measured directory therefore gains no `.git`, no
* index and no object store of its own. Its ignore rules come from the private
* repository's `info/exclude`; the three configuration values below are what a
* byte-faithful measurement needs — no line-ending translation on add
* (`core.autocrlf`, `core.safecrlf`), and no advice line when the directory
* happens to hold a repository of its own, which git records as an embedded
* repository instead of walking into it.
*
* @param runner - the injected subprocess runner.
* @param executable - the resolved git executable.
* @param env - the scrubbed environment.
* @param cwd - absolute Session working directory, outside any repository.
* @param scratch - this Session's private directory; the repository is created inside it.
* @param signal - cancellation.
* @param diagnostics - where step costs and failures are reported.
* @param context - the Session (and attempt) this call belongs to.
* @returns the synthetic workspace, or null when git refused to create one.
*/
async function locateSyntheticWorkspace(runner, executable, env, cwd, scratch, signal, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	const started = Date.now();
	let root;
	try {
		root = await realpath(cwd);
	} catch (error) {
		reportThrown(diagnostics, context, "realpath (working directory)", cwd, started, error);
		return null;
	}
	const repository = join(scratch, "directory");
	const outside = await runner({
		file: executable,
		args: ["rev-parse", "--show-toplevel"],
		cwd: root,
		env: {
			...env,
			LC_ALL: "C"
		},
		timeoutMs: 1e4,
		maxBytes: 64 * 1024,
		signal
	});
	if (outside.exitCode === 0 || !/not a git repository/u.test(outside.stderr)) {
		reportFailure(diagnostics, context, "rev-parse --show-toplevel (synthetic probe)", root, started, outside, outside.exitCode === 0 ? "the directory turned out to be inside a repository" : "git answered something other than \"not a git repository\"");
		return null;
	}
	await mkdir(repository, { recursive: true });
	const initStarted = Date.now();
	const created = await runner({
		file: executable,
		args: [
			"init",
			"--quiet",
			repository
		],
		cwd: root,
		env,
		timeoutMs: 1e4,
		maxBytes: 64 * 1024,
		signal
	});
	if (created.exitCode !== 0) {
		reportFailure(diagnostics, context, "git init (private repository)", root, initStarted, created);
		return null;
	}
	const gitDir = join(repository, ".git");
	await mkdir(join(gitDir, "info"), { recursive: true });
	await writeFile(join(gitDir, "info", "exclude"), SYNTHETIC_EXCLUDES, "utf8");
	for (const [key, value] of [
		["core.autocrlf", "false"],
		["core.safecrlf", "false"],
		["advice.addEmbeddedRepo", "false"]
	]) {
		const configStarted = Date.now();
		const configured = await runner({
			file: executable,
			args: [
				"config",
				"--file",
				join(gitDir, "config"),
				key,
				value
			],
			cwd: root,
			env,
			timeoutMs: 1e4,
			maxBytes: 64 * 1024,
			signal
		});
		if (configured.exitCode !== 0) {
			reportFailure(diagnostics, context, `git config ${key}`, root, configStarted, configured);
			return null;
		}
	}
	reportStep(diagnostics, context, "private repository created", root, started, `gitDir=${gitDir}`);
	return {
		root,
		gitDir,
		scratch,
		env: {
			...env,
			GIT_DIR: gitDir,
			GIT_WORK_TREE: root
		},
		excludes: isInside(root, scratch) ? [toPosix(relative(root, scratch))] : [],
		synthetic: true
	};
}
/**
* Refresh a synthetic workspace's index and return the tree it now states.
*
* Unlike {@link snapshotTree}, this snapshot keeps its index. The index is the
* synthetic workspace's memory: the stat data it carries is what turns a
* measurement into a stat walk instead of a full read — the directory that takes
* 36.7 s to read once costs 0.13 s to re-check. That is the one place in this
* plugin where a stat cache is trusted, and it can, on a filesystem with coarse
* timestamps, miss an edit that preserves both a file's size and its recorded
* timestamps. Git's own racy-timestamp rule already re-reads anything not
* strictly older than the index, which is the case that actually happens. A
* directory whose owner wants the repository path's forced re-read belongs in a
* repository, where that path runs.
*
* @param runner - the injected subprocess runner.
* @param executable - the resolved git executable.
* @param workspace - the synthetic workspace.
* @param timeoutMs - bound for the add; the first pass needs more of it than a turn does.
* @param signal - cancellation.
* @param diagnostics - where step costs and failures are reported.
* @param context - the Session (and attempt) this call belongs to.
* @returns the tree object id, or null when git refused the snapshot.
*/
async function snapshotSyntheticTree(runner, executable, workspace, timeoutMs, signal, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	const pathspec = workspace.excludes.length === 0 ? [] : [
		"--",
		".",
		...workspace.excludes.map((path) => `:(exclude)${path}`)
	];
	const first = Date.now();
	let added;
	try {
		added = await runner({
			file: executable,
			args: [
				"add",
				"--all",
				"--ignore-errors",
				...pathspec
			],
			cwd: workspace.root,
			env: workspace.env,
			timeoutMs,
			maxBytes: GIT_MAX_BYTES,
			signal
		});
	} catch (error) {
		reportThrown(diagnostics, context, timeoutMs > GIT_TIMEOUT_MS ? "add --all (first pass)" : "add --all (incremental)", workspace.root, first, error);
		return null;
	}
	if (added.exitCode !== 0 && added.exitCode !== 1) {
		reportFailure(diagnostics, context, timeoutMs > GIT_TIMEOUT_MS ? "add --all (first pass)" : "add --all (incremental)", workspace.root, first, added, "git refused the add");
		return null;
	}
	const writeStarted = Date.now();
	let written;
	try {
		written = await runner({
			file: executable,
			args: ["write-tree"],
			cwd: workspace.root,
			env: workspace.env,
			timeoutMs: GIT_TIMEOUT_MS,
			maxBytes: 64 * 1024,
			signal
		});
	} catch (error) {
		reportThrown(diagnostics, context, "write-tree", workspace.root, writeStarted, error);
		return null;
	}
	if (written.exitCode !== 0) {
		reportFailure(diagnostics, context, "write-tree", workspace.root, writeStarted, written);
		return null;
	}
	const tree = written.stdout.trim();
	if (!/^[0-9a-f]{40,64}$/u.test(tree)) {
		reportFailure(diagnostics, context, "write-tree", workspace.root, writeStarted, written, "the answer was not a tree id");
		return null;
	}
	reportStep(diagnostics, context, timeoutMs > GIT_TIMEOUT_MS ? "add --all (first pass)" : "add --all (incremental)", workspace.root, first, `tree=${tree.slice(0, 12)}`);
	return tree;
}
/**
* Per-file counts between two snapshot trees of a synthetic workspace.
*
* Same measurement as {@link diffTrees}, with one correction that only a
* synthetic workspace needs. A directory inside the measured tree that holds a
* repository of its own is recorded by git as an embedded repository — a
* gitlink, not a directory of files — and `--numstat` then reports the pointer
* it moved as one added and one deleted line. Nobody changed a line. An entry
* like that is re-reported as a binary file, which the bar draws as a name
* without counts, and the README says so.
*
* @param runner - the injected subprocess runner.
* @param executable - the resolved git executable.
* @param workspace - the addressed synthetic workspace.
* @param before - turn-start tree id.
* @param after - turn-end tree id.
* @param signal - cancellation.
* @param diagnostics - where step costs and failures are reported.
* @param context - the Session (and attempt) this call belongs to.
* @returns changed files relative to the Session working directory.
* @throws when git fails or the output exceeded the cap.
*/
async function diffSyntheticTrees(runner, executable, workspace, before, after, signal, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	const changes = await diffTrees(runner, executable, workspace, before, after, signal, diagnostics, context);
	if (changes.length === 0) return changes;
	const listed = await runner({
		file: executable,
		args: [
			"ls-files",
			"-s",
			"-z",
			"--",
			...changes.map((change) => change.path)
		],
		cwd: workspace.root,
		env: {
			...workspace.env,
			GIT_LITERAL_PATHSPECS: "1"
		},
		timeoutMs: GIT_TIMEOUT_MS,
		maxBytes: GIT_MAX_BYTES,
		signal
	});
	if (listed.exitCode !== 0) {
		reportFailure(diagnostics, context, "ls-files (embedded repositories)", workspace.root, Date.now(), listed);
		return changes;
	}
	const embedded = /* @__PURE__ */ new Set();
	for (const record of listed.stdout.split("\0")) {
		const tab = record.indexOf("	");
		if (tab >= 0 && record.slice(0, tab).startsWith("160000 ")) embedded.add(record.slice(tab + 1));
	}
	if (embedded.size === 0) return changes;
	return changes.map((change) => embedded.has(change.path) ? {
		path: change.path,
		added: 0,
		deleted: 0,
		binary: true
	} : change);
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
* @param diagnostics - where step costs and failures are reported.
* @param context - the Session (and attempt) this call belongs to.
* @returns changed files relative to the repository root.
* @throws when git fails or the output exceeded the cap.
*/
async function diffTrees(runner, executable, workspace, before, after, signal, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	if (before === after) return [];
	const started = Date.now();
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
	if (result.exitCode !== 0) {
		reportFailure(diagnostics, context, "diff-tree", workspace.root, started, result);
		throw new Error(`git diff-tree failed: ${result.stderr.trim()}`);
	}
	return parseNumstat(result.stdout);
}
/** Marker file every scratch directory of this plugin starts with. */
const SCRATCH_MARKER_FILE = ".dsh-chat-diff-legacy-scratch.json";
/** Create one private scratch directory outside the work tree, canonicalized, and mark it. */
async function createScratch(label, marker) {
	const scratch = await realpath(await mkdtemp(join(tmpdir(), `${label}-`)));
	await writeFile(join(scratch, SCRATCH_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
	return scratch;
}
/** Remove one private scratch directory and everything git wrote into it. */
async function removeScratch(scratch, diagnostics = SILENT_DIAGNOSTICS, context = {}) {
	const started = Date.now();
	try {
		await rm(scratch, {
			recursive: true,
			force: true
		});
	} catch (error) {
		reportThrown(diagnostics, context, "remove scratch directory", scratch, started, error);
	}
}
/** How old a scratch directory must be before a sweep may remove it. */
const SCRATCH_ORPHAN_MIN_AGE_MS = 1440 * 6e4;
/** Most candidates one startup sweep will inspect, so a huge temp root cannot stall boot. */
const SCRATCH_GC_LIMIT = 200;
/**
* Remove scratch directories this plugin left behind when a host died.
*
* A plugin teardown removes every scratch it owns; only a crash, a kill or a
* failed removal can leave one. This sweep is the answer to those, and it is
* deliberately conservative: the directory name must carry the plugin's prefix,
* the marker file must exist and name this plugin with a known schema, and the
* directory must not have been written to for {@link SCRATCH_ORPHAN_MIN_AGE_MS}.
* A live host writes into its scratch on every turn, so an in-use directory is
* never old enough to qualify, and a foreign directory is never touched at all.
*
* @param options - the prefix, the owner name, and the bounds.
* @returns what the sweep removed, kept and refused to recognise.
*/
async function collectOrphanScratches(options) {
	const prefix = `${options.label}-`;
	const minAgeMs = options.minAgeMs ?? SCRATCH_ORPHAN_MIN_AGE_MS;
	const now = options.now ?? Date.now();
	const root = options.root ?? tmpdir();
	const diagnostics = options.diagnostics ?? SILENT_DIAGNOSTICS;
	const removed = [];
	const kept = [];
	const unrecognised = [];
	let candidates;
	try {
		candidates = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix)).map((entry) => join(root, entry.name)).slice(0, SCRATCH_GC_LIMIT);
	} catch (error) {
		reportThrown(diagnostics, {}, "read the temporary root", root, Date.now(), error);
		return {
			removed,
			kept,
			unrecognised
		};
	}
	for (const candidate of candidates) {
		let marker;
		try {
			marker = JSON.parse(await readFile(join(candidate, SCRATCH_MARKER_FILE), "utf8"));
		} catch {
			unrecognised.push(candidate);
			continue;
		}
		if (marker.plugin !== options.plugin || marker.schema !== 1) {
			unrecognised.push(candidate);
			continue;
		}
		let age;
		try {
			age = now - (await stat(candidate)).mtimeMs;
		} catch {
			unrecognised.push(candidate);
			continue;
		}
		if (age < minAgeMs) {
			kept.push(candidate);
			continue;
		}
		const started = Date.now();
		try {
			await rm(candidate, {
				recursive: true,
				force: true
			});
			removed.push(candidate);
			reportStep(diagnostics, {}, "removed an orphaned scratch directory", candidate, started, `kind=${marker.kind} ageMs=${String(Math.round(age))}`);
		} catch (error) {
			reportThrown(diagnostics, {}, "remove an orphaned scratch directory", candidate, started, error);
		}
	}
	return {
		removed,
		kept,
		unrecognised
	};
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
//#region src/synthetic-workspace.ts
/** How long a workspace with no consumers is kept before its scratch is removed. */
const SCRATCH_IDLE_MS = 5 * 6e4;
/** First backoff after a failed first pass; doubles per attempt up to the ceiling. */
const WARMUP_BACKOFF_BASE_MS = 1e3;
/** Ceiling for the retry backoff: a permanently unreadable directory is retried, but rarely. */
const WARMUP_BACKOFF_MAX_MS = 5 * 6e4;
/**
* How long a turn's tool gate waits for a cold first pass.
*
* Accuracy is the priority: the gate waits so the turn's baseline is written
* before its first mutating tool, which is what makes a cold turn measurable at
* all. The bound is what keeps a pathological directory from holding every tool
* call: past it, the pass keeps running in the background, this turn is logged
* as unmeasured, and the next turn inherits the finished pass.
*/
const WARMUP_GATE_BUDGET_MS = 12e4;
/** The canonical directory a key stands for, spelled the way the filesystem does. */
async function workspaceRoot(cwd) {
	const canonical = await realpath(cwd);
	return {
		key: process.platform === "win32" ? canonical.toLowerCase() : canonical,
		canonical
	};
}
/** The registry of shared synthetic workspaces. */
var SyntheticWorkspaces = class {
	entries = /* @__PURE__ */ new Map();
	claimed = /* @__PURE__ */ new Map();
	disposed = false;
	constructor(logger, lifetime, options = {}) {
		this.logger = logger;
		this.lifetime = lifetime;
		this.options = options;
	}
	/** The clock the backoff is measured against. */
	get now() {
		return (this.options.now ?? Date.now)();
	}
	/** The diagnostics sink, with `info` routed to the logger when it has one. */
	get diagnostics() {
		return this.options.diagnostics ?? SILENT_DIAGNOSTICS;
	}
	/** Every entry currently held, for diagnostics and specs. */
	entriesHeld() {
		return [...this.entries.values()];
	}
	/**
	* Claim the workspace for one Session and get it as ready as the budget allows.
	*
	* Claiming is idempotent per Session: a second call for the same Session and
	* directory returns the same entry and does not disturb the pass in flight.
	* @param sessionId - the Session that will measure turns here.
	* @param cwd - the Session working directory, outside any repository.
	* @param engine - the snapshot engine that mints and warms the workspace.
	* @param signal - cancellation.
	* @param budgetMs - how long this caller may be kept waiting for the first pass.
	* @returns the entry, the repository and whether it is ready.
	*/
	async prepare(sessionId, cwd, engine, signal, budgetMs) {
		if (this.disposed) return {
			entry: void 0,
			workspace: null,
			ready: false
		};
		let key;
		let canonical;
		try {
			({key, canonical} = await workspaceRoot(cwd));
		} catch (error) {
			this.diagnostics.failed({
				operation: "realpath (workspace key)",
				root: cwd,
				elapsedMs: 0,
				sessionId,
				detail: error instanceof Error ? error.message : String(error)
			});
			return {
				entry: void 0,
				workspace: null,
				ready: false
			};
		}
		const previous = this.claimed.get(sessionId);
		if (previous !== void 0 && previous !== key) await this.release(sessionId);
		let entry = this.entries.get(key);
		if (entry === void 0) {
			let scratch;
			try {
				scratch = await engine.createScratch("synthetic", key);
			} catch (error) {
				this.diagnostics.failed({
					operation: "create scratch directory",
					root: key,
					elapsedMs: 0,
					sessionId,
					detail: error instanceof Error ? error.message : String(error)
				});
				return {
					entry: void 0,
					workspace: null,
					ready: false
				};
			}
			entry = {
				key,
				root: canonical,
				scratch,
				workspace: null,
				state: "cold",
				attempts: 0,
				warm: void 0,
				retryAt: 0,
				consumers: /* @__PURE__ */ new Set(),
				lastUsed: this.now,
				retireTimer: void 0,
				lastFailure: void 0,
				engine
			};
			this.entries.set(key, entry);
			this.diagnostics.step({
				operation: "shared workspace opened",
				root: key,
				elapsedMs: 0,
				sessionId,
				detail: `scratch=${scratch}`
			});
		}
		if (entry.retireTimer !== void 0) {
			clearTimeout(entry.retireTimer);
			entry.retireTimer = void 0;
		}
		entry.consumers.add(sessionId);
		entry.lastUsed = this.now;
		this.claimed.set(sessionId, key);
		const ready = await this.ready(entry, engine, signal, budgetMs);
		return {
			entry,
			workspace: entry.workspace,
			ready
		};
	}
	/**
	* Make a claimed workspace as ready as the budget allows.
	*
	* This is what a turn calls before it snapshots its baseline. A pass already
	* in flight is awaited rather than started again, so N Sessions arriving at a
	* cold directory produce one pass, not N.
	* @param entry - the shared workspace.
	* @param engine - the snapshot engine.
	* @param signal - cancellation.
	* @param budgetMs - how long this caller may wait; the pass itself is never cut short by it.
	* @returns whether the first pass has finished.
	*/
	async ready(entry, engine, signal, budgetMs) {
		entry.lastUsed = this.now;
		if (this.stateOf(entry) === "ready") return true;
		if (this.stateOf(entry) === "warming" && entry.warm !== void 0) {
			await this.withinBudget(entry.warm, budgetMs);
			return this.stateOf(entry) === "ready";
		}
		const now = this.now;
		if (this.stateOf(entry) === "failed" && now < entry.retryAt) {
			this.info(`first pass is backing off for ${String(entry.retryAt - now)}ms after ${String(entry.attempts)} failed attempt(s)${entry.lastFailure === void 0 ? "" : `: ${entry.lastFailure}`}`);
			return false;
		}
		const attempt = entry.attempts + 1;
		entry.attempts = attempt;
		entry.state = "warming";
		entry.warm = this.runPass(entry, engine, signal, attempt);
		await this.withinBudget(entry.warm, budgetMs);
		return this.stateOf(entry) === "ready";
	}
	/** The entry's warm state, read through a call so a caller's narrowing cannot mask a pass landing. */
	stateOf(entry) {
		return entry.state;
	}
	/**
	* Run one first pass and settle the entry's state when it lands.
	*
	* The pass is never cancelled by a caller's budget: it is the expensive work
	* every later turn depends on, so it runs to its own git timeout and reports
	* its outcome to whoever is still holding the workspace.
	*/
	runPass(entry, engine, signal, attempt) {
		const started = this.now;
		const first = [...entry.consumers][0];
		const context = first === void 0 ? { attempt } : {
			sessionId: first,
			attempt
		};
		const pass = (async () => {
			if (this.lifetime.aborted) {
				entry.state = "failed";
				entry.lastFailure = "aborted (plugin disposed)";
				return false;
			}
			try {
				const workspace = entry.workspace ?? await engine.locateDirectory(entry.root, entry.scratch, signal, context);
				if (workspace === null) {
					this.fail(entry, "private repository", "git could not address the directory", started, context, attempt);
					return false;
				}
				entry.workspace = workspace;
				const tree = await engine.snapshotDirectory(workspace, true, signal, context);
				if (tree === null) {
					this.fail(entry, "first pass over the directory", "git refused the snapshot", started, context, attempt);
					return false;
				}
				entry.state = "ready";
				entry.lastFailure = void 0;
				entry.retryAt = 0;
				this.diagnostics.step({
					operation: "first pass over the directory",
					root: entry.root,
					elapsedMs: this.now - started,
					attempt,
					detail: `tree=${tree.slice(0, 12)}`
				});
				return true;
			} catch (error) {
				const detail = signal.aborted ? "aborted (workspace or plugin disposed)" : error instanceof Error ? error.message : String(error);
				this.fail(entry, "first pass over the directory", detail, started, context, attempt);
				return false;
			}
		})();
		pass.then((landed) => {
			if (entry.warm !== pass) return;
			if (!landed) {
				entry.retryAt = this.now + this.backoff(attempt);
				this.info(`first pass failed; the next attempt for this directory may start in ${String(this.backoff(attempt))}ms`);
			}
			this.diagnostics.step({
				operation: "first pass settled",
				root: entry.root,
				elapsedMs: this.now - started,
				attempt,
				detail: `state=${entry.state}`
			});
		});
		return pass;
	}
	/** Record one failed pass and put the entry back into a retryable state. */
	fail(entry, operation, detail, startedAt, context, attempt) {
		entry.state = "failed";
		entry.lastFailure = detail;
		this.diagnostics.failed({
			operation,
			root: entry.root,
			elapsedMs: this.now - startedAt,
			...context,
			attempt,
			detail
		});
	}
	/** Exponential backoff, capped; never zero, so a failing pass cannot spin. */
	backoff(attempt) {
		const base = this.options.backoffBaseMs ?? WARMUP_BACKOFF_BASE_MS;
		const max = this.options.backoffMaxMs ?? WARMUP_BACKOFF_MAX_MS;
		const grown = base * 2 ** Math.max(0, attempt - 1);
		return Math.min(Number.isFinite(grown) ? grown : max, max);
	}
	/** Wait for `work`, but no longer than `budgetMs`; an unbounded budget waits it out. */
	async withinBudget(work, budgetMs) {
		if (!Number.isFinite(budgetMs)) {
			await work;
			return;
		}
		let timer;
		try {
			await Promise.race([work, new Promise((resolve$1) => {
				timer = setTimeout(resolve$1, Math.max(0, budgetMs));
				timer.unref?.();
			})]);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
		}
	}
	/** Let one Session stop holding its workspace; the last one out starts the idle clock. */
	async release(sessionId) {
		const key = this.claimed.get(sessionId);
		if (key === void 0) return;
		this.claimed.delete(sessionId);
		const entry = this.entries.get(key);
		if (entry === void 0) return;
		entry.consumers.delete(sessionId);
		entry.lastUsed = this.now;
		if (entry.consumers.size > 0) return;
		const idleMs = this.options.idleMs ?? SCRATCH_IDLE_MS;
		if (idleMs <= 0) {
			await this.retire(entry);
			return;
		}
		entry.retireTimer = setTimeout(() => {
			entry.retireTimer = void 0;
			this.retire(entry);
		}, idleMs);
		entry.retireTimer.unref?.();
	}
	/** Remove one unclaimed workspace: wait for its pass, then delete its scratch. */
	async retire(entry) {
		if (entry.consumers.size > 0) return;
		if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
		if (entry.retireTimer !== void 0) {
			clearTimeout(entry.retireTimer);
			entry.retireTimer = void 0;
		}
		if (entry.warm !== void 0) await entry.warm.catch(() => false);
		const last = [...entry.consumers][0];
		await entry.engine?.removeScratch(entry.scratch, last === void 0 ? {} : { sessionId: last }).catch(() => {});
		this.diagnostics.step({
			operation: "shared workspace retired",
			root: entry.root,
			elapsedMs: 0,
			detail: `scratch=${entry.scratch}`
		});
	}
	/** Retire every workspace at once; used on plugin disposal. */
	async disposeAll() {
		this.disposed = true;
		const entries = [...this.entries.values()];
		for (const entry of entries) {
			if (entry.retireTimer !== void 0) {
				clearTimeout(entry.retireTimer);
				entry.retireTimer = void 0;
			}
			entry.consumers.clear();
		}
		await Promise.all(entries.map((entry) => this.retire(entry)));
	}
	/** Log one lifecycle note when the host logger carries `info`. */
	info(message) {
		this.logger.info?.(`chat-diff-summary-legacy: ${message}`);
	}
};

//#endregion
//#region src/tracker.ts
/** Log prefix every line of this plugin carries. */
const PREFIX = "chat-diff-summary-legacy:";
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
/** The real engine: git plumbing writing only into a private scratch directory. */
function createGitEngine(runner, executable, environment, diagnostics = SILENT_DIAGNOSTICS) {
	return {
		locate: (cwd, scratch, signal, context) => locateWorkspace(runner, executable, environment, cwd, scratch, signal, diagnostics, context),
		locateDirectory: (cwd, scratch, signal, context) => locateSyntheticWorkspace(runner, executable, environment, cwd, scratch, signal, diagnostics, context),
		snapshot: (workspace, label, signal, context) => snapshotTree(runner, executable, workspace, `${workspace.scratch}/index-${label}`, workspace.excludes, signal, diagnostics, context),
		snapshotDirectory: (workspace, warm, signal, context) => snapshotSyntheticTree(runner, executable, workspace, warm ? GIT_WARMUP_TIMEOUT_MS : GIT_TIMEOUT_MS, signal, diagnostics, context),
		diff: (workspace, before, after, signal, context) => workspace.synthetic === true ? diffSyntheticTrees(runner, executable, workspace, before, after, signal, diagnostics, context) : diffTrees(runner, executable, workspace, before, after, signal, diagnostics, context),
		createScratch: (kind, root) => createScratch("dsh-chat-diff-legacy", {
			schema: 1,
			plugin: PLUGIN_NAME,
			kind,
			...root === void 0 ? {} : { root },
			pid: process.pid,
			createdAt: (/* @__PURE__ */ new Date()).toISOString()
		}),
		removeScratch: (scratch, context) => removeScratch(scratch, diagnostics, context)
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
	* @param synthetic - the shared synthetic workspaces; one registry serves every Session.
	*/
	constructor(engine, logger, lifetime, synthetic = new SyntheticWorkspaces(logger, lifetime)) {
		this.engine = engine;
		this.logger = logger;
		this.lifetime = lifetime;
		this.synthetic = synthetic;
	}
	/**
	* Open a turn: reset the baseline and queue its snapshot.
	*
	* The snapshot is asynchronous because it is a real git call; the host gates
	* tool dispatch on {@link settle}, so nothing can mutate the work tree between
	* the turn's first tool call and the baseline being written. A synthetic
	* workspace's first pass is queued on the same chain for that reason: waiting
	* is what keeps a cold turn's own changes from being invisible. The wait is
	* bounded by {@link WARMUP_GATE_BUDGET_MS}; a pass that outlives it keeps
	* running for the next turn, and the turn it outlived says so in the log.
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
			if (workspace === null) {
				this.logger.warn(`${PREFIX} session "${sessionId}": no workspace for "${cwd}", so turn ${turn} has no baseline`);
				return;
			}
			const tree = await this.snapshotIn(engine, workspace, "base", signal, { sessionId });
			if (record.turn === turn) record.baseline = tree;
			if (tree === null) this.logger.warn(`${PREFIX} session "${sessionId}": turn ${turn} could not take its baseline snapshot`);
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
				const context = { sessionId };
				const tree = await this.snapshotIn(engine, workspace, "live", signal, context);
				if (tree === null) return;
				const changes = await engine.diff(workspace, baseline, tree, signal, context);
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
				const reason = workspace === null ? `no workspace${record.shared === void 0 ? "" : ` (state=${record.shared.state}${record.shared.lastFailure === void 0 ? "" : `, last failure: ${record.shared.lastFailure}`})`}` : "no baseline snapshot";
				this.logger.warn(`${PREFIX} session "${sessionId}": turn ${turn} has ${reason}; reporting no changes for it`);
				this.remember(record, emptySummary(turn));
				return;
			}
			const engine = await this.engine();
			if (engine === null) {
				this.remember(record, emptySummary(turn));
				return;
			}
			const context = { sessionId };
			const end = await this.snapshotIn(engine, workspace, "end", signal, context);
			if (end === null) {
				this.logger.warn(`${PREFIX} session "${sessionId}": turn ${turn} could not take its closing snapshot; reporting no changes for it`);
				this.remember(record, emptySummary(turn));
				return;
			}
			this.remember(record, summarize(turn, await engine.diff(workspace, baseline, end, signal, context)));
		});
	}
	/**
	* Resolve once this Session has no queued snapshot work.
	*
	* The host's tool gate awaits this before dispatching a call, which is what
	* keeps the baseline ahead of the turn's first mutation — including on a cold
	* synthetic workspace, whose first pass is queued here too.
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
	/** Forget one Session: release its share of the workspace and delete its own scratch. */
	async disposeSession(sessionId) {
		const record = this.sessions.get(sessionId);
		if (record === void 0) return;
		this.sessions.delete(sessionId);
		await record.chain;
		await this.synthetic.release(sessionId);
		if (record.scratch === void 0) return;
		await (await this.engine())?.removeScratch(record.scratch, { sessionId }).catch(() => {});
	}
	/** Forget every Session, then every shared workspace; used on plugin disposal. */
	async dispose() {
		await Promise.all([...this.sessions.keys()].map((sessionId) => this.disposeSession(sessionId)));
		await this.synthetic.disposeAll();
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
			shared: void 0,
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
				this.logger.warn(`${PREFIX} session "${record.sessionId}": ${error instanceof Error ? error.message : String(error)}`);
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
	/**
	* Resolve the Session's workspace: the repository enclosing `cwd`, or the
	* shared private repository for a directory no repository encloses.
	*
	* A Session keeps the workspace it first resolved, because a baseline tree only
	* means anything in the object store it was written to, and switching stores
	* mid-Session would compare a tree the other store cannot resolve. A directory
	* that gains a repository later is measured by the repository path from the
	* next Session on.
	* @param engine - the resolved snapshot engine.
	* @param record - the Session's record.
	* @param cwd - the Session working directory.
	* @param signal - cancellation.
	* @returns the workspace, or null when git could not address the directory at all.
	*/
	async workspaceFor(engine, record, cwd, signal) {
		if (record.workspace !== void 0 && record.workspace !== null) {
			if (record.shared !== void 0) await this.awaitFirstPass(record, engine, signal);
			return record.shared?.workspace ?? record.workspace;
		}
		const context = { sessionId: record.sessionId };
		const located = await engine.locate(cwd, async () => record.scratch ??= await engine.createScratch("repository", cwd), signal, context);
		if (located !== null) {
			record.workspace = located;
			return located;
		}
		if (record.shared === void 0) {
			const prepared = await this.synthetic.prepare(record.sessionId, cwd, engine, signal, WARMUP_GATE_BUDGET_MS);
			record.shared = prepared.entry;
			record.workspace = prepared.workspace;
			if (prepared.entry !== void 0 && !prepared.ready) await this.awaitFirstPass(record, engine, signal);
			return prepared.workspace;
		}
		await this.awaitFirstPass(record, engine, signal);
		record.workspace = record.shared.workspace ?? null;
		return record.workspace;
	}
	/**
	* Wait for this Session's shared first pass, and say so when a turn opens
	* before it is ready.
	*
	* The wait is what makes a cold turn measurable: the pass is the only way to
	* know what the directory looked like, so the turn's baseline cannot be taken
	* before it. Past the budget the turn proceeds without one, which the log
	* states plainly; the pass keeps running for the turns after it.
	*/
	async awaitFirstPass(record, engine, signal) {
		const entry = record.shared;
		if (entry === void 0 || entry.state === "ready") return;
		const started = Date.now();
		if (await this.synthetic.ready(entry, engine, signal, WARMUP_GATE_BUDGET_MS)) return;
		this.logger.warn(`${PREFIX} session "${record.sessionId}": turn ${record.turn} opened ${String(Date.now() - started)}ms into this directory's first pass, which is not ready (state=${entry.state}${entry.lastFailure === void 0 ? "" : `, last failure: ${entry.lastFailure}`}); the turn may report nothing, and the next turn inherits the pass`);
	}
	/** Snapshot the work tree the way this Session's workspace is measured. */
	async snapshotIn(engine, workspace, label, signal, context) {
		if (workspace.synthetic === true) return engine.snapshotDirectory(workspace, false, signal, context);
		return engine.snapshot(workspace, label, signal, context);
	}
};
/** Resolve the real git engine once, or null when this host has no usable git. */
function createEngineProvider(runner, logger, signal) {
	let resolved;
	const diagnostics = {
		failed: (event) => logger.warn(describeFailure(event)),
		step: (event) => logger.info?.(describeStep(event))
	};
	return () => {
		resolved ??= (async () => {
			const environment = gitEnvironment();
			const executable = await resolveGit(runner, environment, signal);
			if (executable === null) {
				logger.warn(`${PREFIX} git is unavailable; change summaries are disabled`);
				return null;
			}
			return createGitEngine(runner, executable, environment, diagnostics);
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
	collectOrphanScratches({
		label: "dsh-chat-diff-legacy",
		plugin: PLUGIN_NAME,
		diagnostics: {
			failed: (event) => ctx.logger.warn(describeFailure(event)),
			step: (event) => ctx.logger.info(describeStep(event))
		}
	}).then((result) => {
		if (result.removed.length > 0 || result.unrecognised.length > 0) ctx.logger.info(`chat-diff-summary-legacy: startup sweep removed ${String(result.removed.length)} orphaned scratch director${result.removed.length === 1 ? "y" : "ies"}, left ${String(result.unrecognised.length)} unrecognised and ${String(result.kept.length)} in use`);
	}, (error) => {
		ctx.logger.warn(`chat-diff-summary-legacy: startup sweep failed: ${error instanceof Error ? error.message : String(error)}`);
	});
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