# dsh-chat-diff-summary-legacy

A Codex-style per-turn change summary bar above the composer, built for the
**legacy** line of the DeepSeek Harness.

```
[ 1 个文件已更改                            +542   -20 ]
```

- **Kernel range: `>=0.1.5-rc.1 <0.1.8`**, verified on `0.1.5-rc.2` (the kernel
  DSH Desktop 2.0.13 ships) and on `0.1.7-rc.2` (the kernel the current desktop
  build ships). See [Compatibility](#compatibility).
- Changed-file count in ordinary text; `+added` in the success token and
  `-deleted` in the error token; one 38px row, 14px radius, 1px border, no heavy
  shadow, no gradient, no glass effect.
- Renders nothing at all when a turn changed nothing.
- Switching Sessions swaps the numbers; two Sessions never share a summary.

## Preview

Captured from the renderer of a real DSH Desktop 2.0.13 / DSH 0.1.5-rc.2 running
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + this plugin, in an isolated
`DSH_HOME`. The nine changed files were written to disk while a real turn was
open, so the turn's own start-to-end measurement produced the numbers shown — and
`git diff --numstat` over the same baseline reproduces them exactly:

| | |
|---|---|
| `docs/preview/01-collapsed-dark.png` | the summary row, dark theme |
| `docs/preview/02-expanded-dark.png` | expanded: the file list unfolds above the row |
| `docs/preview/03-collapsed-light.png` | the summary row, light theme |
| `docs/preview/04-expanded-light.png` | expanded, light theme |

The expanded pair also shows the overlay behaviour: the reply behind the panel is
partly covered by it rather than pushed up.

中文说明见 [README.md](README.md).

Both themes are the host's own tokens rendered by the host's own theme layer —
the plugin contributes no colour of its own.

## Layout

- The summary row **shrinks to its own contents** — a compact pill around
  `N files changed  +a  -b` — and is centred
  (`.cdsl-bar { width: max-content; max-width: 100% }`). It is not a composer-wide
  bar. A label too long for the composer ellipsizes; the counts stay whole.
- Inside the row the label and the counts sit **one character apart**
  (`gap: 1em`); there is no elastic spacer pushing them to opposite edges.
- The file list it opens keeps **one third** of the composer's width and is
  centred, so a long file name has room before it ellipsizes.
- The list **pages at seven rows**: its height is exactly
  `7 × 38px + 2 × 6px`, so a row is never half-clipped at the fold, and the rest
  is reached by scrolling inside the panel. The wheel is kept inside it
  (`overscroll-behavior: contain`), so reaching the last file does not start
  scrolling the conversation behind the composer. Its scrollbar is drawn from the
  host's own `--dsh-scrollbar-*` tokens.
- The list **floats over the conversation**: it is taken out of flow
  (`position: absolute; bottom: calc(100% + 2px)`) and covers whatever is behind
  it. Expanding must not push the transcript up or shrink the viewport above the
  composer, so the row stays the only thing in flow and the dock keeps its height.
  Measured in DSH Desktop: the row stays at 38px and its top does not move, while
  the panel covers 280px above it.
- Being an overlay, the panel carries the host's own elevation token
  (`--dsw-shadow-lv3`, falling back to no shadow) so it reads as a surface over
  the text. The row itself stays flat.
- The list widens as the composer narrows, because a third of a 420px composer
  could not hold a name and two counts: `50%` below 760px, full width below 520px.

Measured in the host's own Chromium, in a 990px composer:

```
bar width         211px   (= its content: label + 1em + counts + padding)
label↔counts gap   13px   (= 1em at 13px)
list width        330px   (= 1/3 of 990)
list height       278px   (= 7 × 38 + 2 × 6)
rows fully shown    7      scrollable: yes        (10 files in the panel)
row height        38px     unchanged when the panel opens — nothing is pushed
panel covers     280px     above the row, over the transcript
```

To change the proportions, edit `src/client/styles.ts`; the page size is the
single `--cdsl-list-rows` value on `.cdsl-root`.

## Live updates during a turn

The bar follows a running turn; it does not wait for the turn to end.

- **Baseline** at `turn/start`, as before.
- **Re-measured after every settled tool call** (`tool/result`). The measurement
  is the same baseline-to-work-tree diff the turn's end takes, so the numbers a
  running turn shows are the numbers it will finish with.
- **Coalesced** two ways: one measurement is in flight at a time, and two
  measurements of one Session are never closer than `PROGRESS_INTERVAL_MS`
  (400 ms) apart. A burst of tool calls therefore costs one walk of the tree, not
  one per call. The turn's own end is never throttled, so a change dropped by the
  interval is only ever *late* — reflected at the next tool call or at `turn/end`
  — never missing.
- **The browser re-reads on every durable event**, coalesced to one read in
  flight at a time, and a read aimed at the open turn waits for the measurement
  already under way rather than answering from the previous one. Client-only live
  frames (streamed chunks) are deliberately excluded, or the bar would re-read on
  every token of a reply.
- A re-read that reports the same numbers keeps the snapshot's identity, so a
  running turn does not churn renders and **does not fold the file list** the
  user just opened.

Measured on a real turn in DSH Desktop 2.0.13 whose three `bash` calls each slept
six seconds — the bar appeared, then grew, strictly inside the turn:

```
t+1…6s   hidden            (nothing changed yet)
t+7s     1 个文件已更改  +2   (turn still running)
t+14s    2 个文件已更改  +3
t+20s    3 个文件已更改  +6
t+24s    turn ends, numbers stand
```

## Git semantics

The numbers are a **working tree to working tree** comparison, not
`git diff HEAD`:

1. At `turn/start`, the complete work tree is written as a tree object.
2. At `turn/end`, the same again.
3. The two trees are diffed with `git diff-tree -r -M -z --numstat`.

Because both snapshots read the same work tree, anything the user had already
staged or left dirty before the turn is present in **both** and contributes
nothing. Because the second snapshot reads the work tree rather than a tool log,
edits made through a shell command — `sed`, a script, a Gradle task, a Python
one-liner — are captured exactly like a file-tool edit.

### How the repository is left untouched

Every write goes into a private scratch directory created with `mkdtemp`:

- `GIT_OBJECT_DIRECTORY` points at the scratch store, so new blobs and trees land
  there; the repository's own store is attached read-only through
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`.
- Each snapshot writes through its own `GIT_INDEX_FILE` inside the scratch.
- The private index is seeded with `git read-tree HEAD`. It is deliberately
  **not** a copy of the repository's index — see below.
- The plugin never runs `git add` against the project index, never commits,
  never touches HEAD or refs, never stashes, checks out or resets.

`tests/git.spec.ts` hashes the repository's `.git/index`, `HEAD`, `for-each-ref`
output and every file under `.git/objects` before and after a turn that
modifies, adds, deletes, renames and binarises files, and asserts all four are
byte-identical. The scratch directory is removed when the Session is disposed
and when the plugin is disposed.

### One real bug worth naming

Seeding the private index by **copying the repository's index** is unsound, and
an earlier revision of this plugin did it. A copied index carries the
repository's stat cache, and `git add` is allowed to trust a cached stat: when
an edit preserves a file's byte length and the copy's own mtime lands after the
file's, git skips re-hashing and writes a tree holding the *previous* content.
Measured on macOS with APFS, that silently produced a stale tree in **2 of 40**
same-length edits — a turn whose change went unreported. `git read-tree HEAD`
populates entries with no stat data, so `git add` must hash every path; the same
probe scored **0 of 40**. `tests/git.spec.ts` keeps that probe as a regression
guard.

## Compatibility

| | |
|---|---|
| **Declared** | `>=0.1.5-rc.1 <0.1.8` — `dsh.engines.dsh` in `package.json` |
| **Verified** | `0.1.5-rc.2` (the kernel DSH Desktop 2.0.13 ships) and `0.1.7-rc.2` (the kernel the current desktop build ships) |
| **Untested** | `0.1.5-rc.1`, the 0.1.6 line, and other patches on either line |
| **Out of scope** | `0.1.8` and later |

**The Desktop version and the kernel version are two different numbers.** DSH
Desktop is on `2.0.x`; the DeepSeek Harness kernel is on `0.1.x`. This plugin has
been exercised against two pairings: **DSH Desktop 2.0.13 + kernel 0.1.5-rc.2**
and **the current desktop build + kernel 0.1.7-rc.2**.

To read the kernel version you actually have:

```bash
# @deepseek-ai/dsh-base carries the kernel version
node -p "require(process.env.HOME + '/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/package.json').version"
# → 0.1.5-rc.2
```

**Why the upper bound is `0.1.8`.** Every host surface this plugin touches exists
in the 0.1.5 line: the `conversation.input.dock` slot, route registration through
`ctx.connection.fetch`, and the `session/event` and `tools/pre-execute` events.
Every one of them is still present in `0.1.7-rc.2` (`ctx.sessions.binding(id)`
still answers `{ sessionId, session, eventSource, ctx }`), so the ceiling was
raised to cover the kernel the current desktop build ships; the 0.1.6 line is
untested and `0.1.8` and later are out of scope.

**The field is a declaration, not a gate.** `dsh.engines.dsh` is the same field
`@linxin666/*` and other third-party plugins use (inside the `dsh` object,
alongside `bundle` and `client`); the current DSH loading path does not read it,
so it cannot block a load. It states the range the author supports and has
tested — it is not a runtime version check.

## What is deliberately not implemented

- **Diff review.** 0.1.5-rc.2 has no `changes-review` surface, so clicking the
  bar only expands and collapses a compact file list. File names are plain text,
  not links.
- **Persistence.** Summaries live in the host process. Restarting the host drops
  them, and the bar honestly hides until the next turn completes.

## Known boundaries

- A repository is summarized as a whole: when a Session's working directory is a
  subdirectory of one, the paths reported are relative to the repository root.
- Two Sessions working in the same repository at the same time each measure their
  own turn boundaries, but they share one work tree; concurrent edits can appear
  in both Sessions' summaries.
- Line counts follow the repository's own git configuration, including
  `.gitattributes` filters and `core.autocrlf`.
- The file list is capped at 200 entries; the count stays complete and the list
  says how many were omitted.
- The scratch directory is removed when the shared workspace it belongs to is
  retired, and everything is removed when the plugin is disposed — but *not* when
  the host process is killed outright, where no disposer runs. A `SIGKILL`ed host
  therefore leaves `dsh-chat-diff-legacy-*` directories under the system temporary
  root, and each one carries a `.dsh-chat-diff-legacy-scratch.json` marker naming
  the plugin, the kind of workspace and the measured directory. The next plugin
  start sweeps marked directories that have not been written to for 24 hours; a
  directory without a marker this plugin can read is never touched.

## Non-Git workspaces

When a Session's working directory is not inside any repository, the plugin mints
a **private repository inside a scratch directory** and measures the directory
with it: `git init` happens there alone, so the measured directory gains no
`.git`, no index and no object store (`tests/git.spec.ts` asserts it). The
measurement is still entirely git's — `add --all`, `write-tree`,
`diff-tree --numstat`; no file is walked or hashed by this plugin.

- **One workspace per directory, shared by every Session in it.** The workspace is
  keyed by `realpath(cwd)`, case-folded on Windows, so a second Session in the same
  directory reuses the first one's repository and object store instead of paying
  another whole-directory pass. A Session ending does not delete a workspace
  another Session is still measuring through: the last consumer out starts a
  five-minute idle window, and plugin disposal retires everything at once.
- **The first pass no longer costs a turn its numbers.** Reading every accepted
  file once measured **36.7 s** and about **810 MB** of temporary object store on
  a 1.7 GB / 28k-file directory with the default excludes. That pass now runs on
  the Session's chain — the host's tool gate awaits it — so the turn's baseline is
  written before its first mutating tool and the turn is measured like any other.
  Accuracy is worth the wait. The wait is bounded (`WARMUP_GATE_BUDGET_MS`,
  120 s by default): a pass that outlives it keeps running in the background, and
  the turn it outlived says in the log that it has no baseline rather than going
  quietly empty. From then on a turn costs a stat walk: **0.13 s** on the same
  directory.
- **A failed first pass is retried, not remembered.** The failure, the attempt
  count and git's own words stay on the shared workspace, and a later turn retries
  behind an exponential backoff (1 s, doubling to a 5-minute ceiling). Diagnostics
  name the step that failed — `realpath`, `rev-parse`, `git init`, `git config`,
  `add --all` (first pass or incremental), `write-tree`, `diff-tree`, a timeout or
  a disposal abort — with the Session, the directory, the exit code, git's
  truncated stderr and the elapsed time.
- **Default ignore rules** live in the private repository's `info/exclude`; a
  `.gitignore` inside the directory still applies:

  ```text
  .git/  .hg/  .svn/  node_modules/
  dist/  build/  out/  target/  coverage/  __pycache__/  .venv/  venv/
  *.apk  *.zip  *.7z  *.rar  *.exe  *.dll  *.so  *.dylib  *.iso  *.dmg  *.msi
  ```

- **No line-ending translation**: the private repository pins
  `core.autocrlf=false` and `core.safecrlf=false`, so counts describe the bytes on
  disk rather than one repository's checkout policy.
- **This mode trusts git's stat cache.** The repository path re-hashes every path
  on every turn for correctness (see `snapshotTree`); the private-repository path
  re-reads only what changed, because reading everything again is what it exists
  to avoid. On a filesystem with coarse timestamps (FAT/exFAT, some network
  shares) an edit that keeps both a file's size and its recorded timestamps can be
  missed. A directory that needs the strict behaviour belongs in a repository,
  where the repository path runs.
- **A repository embedded in the directory** follows git's own embedded-repository
  (gitlink) semantics: nothing inside it is reported file by file, and when its own
  commit advances the bar lists that directory as one entry **without line counts**
  (`diffSyntheticTrees` rewrites the `+1 -1` git reports for a gitlink, so no line
  count is invented). For per-file detail inside it, point the Session's working
  directory at that repository.
- **A Windows directory junction is followed**, so content reachable through one
  enters the snapshot. The default excludes cover dependency trees and build
  output, not arbitrary junctions.
- **A user-level `core.excludesFile` applies on POSIX only**: on Windows the
  environment this plugin hands git carries no user profile path, so git cannot
  read `~/.gitconfig` and only the directory's own `.gitignore` and the default
  rules above apply.

## Install

Two shapes, both standard DSH profile bundles (a node half in `exports["."]`, a
browser half in `exports["./client"]` discovered through the `dsh.client`
declaration, and a `cordis.patch.yml` that inserts this plugin's row and disables
nothing).

**The install path is only where the plugin's source lives.** The plugin registers
on the whole DSH profile that installed it and applies to every Session in that
profile, whatever disk or directory the project sits on — a `link:` specifier
points at source, it does not narrow the plugin's workspace. Which working tree
gets measured is decided per Session, from that Session's own
`session.header.cwd`. There is no fixed path, allowlist or project-root filter
anywhere in this plugin; `process.cwd()` appears only as the working directory of
the `git --version` and `xcode-select -p` probes, never as a measurement scope.

**Live link** — the profile follows this working tree, so an edit plus
`npm run build` is enough:

```bash
dsh plugin --profile <profile> add link:/path/to/dsh-chat-diff-summary-legacy
```

**Packed artifact** — a self-contained snapshot; redeploy after every change:

```bash
npm run verify                                        # typecheck, build, tests
npm pack --pack-destination release                   # → release/<name>-<version>.tgz
dsh plugin --profile <profile> add "file:$PWD/release/<name>-<version>.tgz"
```

Either way the plugin only takes effect once the **host process** has loaded it,
so restart DSH Desktop afterwards. The browser half alone can be picked up by a
page reload; the node half cannot.

## Deployed on this machine

Installed into the live `~/.dsh` profile on 2026-09-24 — first as a packed
artifact, then switched to a **live link** — and verified against it:

- `profiles/desktop/package.json` lists
  `"dsh-chat-diff-summary-legacy": "link:/Volumes/Parallels_SSD/ai/ui-legacy"`,
  and `profiles/desktop/node_modules/dsh-chat-diff-summary-legacy` is a symlink
  resolving back to this directory.
- Switching shapes changed exactly one dependency spec: 11 dependencies before
  and after, none added or removed, every other spec identical, the
  `dsh.profile.bundles` list unchanged at 13 entries, and the lockfile's key set
  unchanged at 382 entries. All ten third-party plugins still resolve at their
  declared versions.
- The packaged `--dump-config` composes the real profile with
  `- id: chat-diff-summary-legacy` present at the same position, and no row of
  this plugin is disabled; the four profile files are byte-identical before and
  after that check.
- The node half is loaded into the host process, so a **restart** is what makes
  a change live. The browser half alone comes back on a page reload.

## Development

```bash
npm install
npm run typecheck
npm run build      # lib/index.js (host) and lib/client.js (browser)
npm run test
npm run verify     # all three, in order
```

The browser half is loaded through `window.__ModuleLoader__`, so `react` and
`react/jsx-runtime` are declared external — both in `tsdown`'s `external` option
and in `peerDependencies`, because `tsdown` 0.15 has no `deps.neverBundle` key
and an unrecognized option is a silent no-op that would ship a second React
(`tests/bundle.spec.ts` asserts the bundle's only two `require` calls).

No `@deepseek-ai/*` package is imported at runtime by either half: every host
service this plugin consumes is declared structurally in `src/host.ts` and
`src/client/contract.ts`, with the shipped 0.1.5-rc.2 call site quoted beside
each member.
