# Agent developer experience — what an agent needs to verify its own work

**Status:** P1 built on this branch (MR !291), 2026-09-08: `just wt`, `just orient`,
`just ci-wait`/`mr-status`, `just detached`, the weekly papercut sweep, and the fresh-worktree
preflights. Of the three P1.2 hooks, `SessionStart`/`SubagentStart` shipped; the `PreToolUse`
Bash-deny hook (guard-bash.mjs) was removed 2026-09-23 as too broad (it denied unrelated commands
repo-wide) — see AGENTS.md §5. P2 and P3 are still proposals. Branch `chore/agent-dx`, worktree
`../futo-notes-agent-dx`.
**Audience:** Justin first, then whichever session picks up an item. Every P1 item is one small MR.
**Evidence base:** 180 Claude Code sessions on both machines (113 on jfedora, 2026-08-05 → 09-05;
67 on the MacBook), the committed `.papercuts.jsonl` (199 cuts, 64 resolves), a survey of every
worktree on both machines, the GitLab pipelines API, a timed cold `just check` in a fresh worktree,
and outside reading: OpenAI's and Martin Fowler's harness-engineering essays, Addy Osmani's agent
harness notes, Claude Code's hooks reference, callstack's `agent-device`, and Maestro MCP.

## 0. Verdict

The harness is already ahead of what the outside writing recommends. Per-worktree slots derive
ports, pooled devices, and sync servers; the spec is the QA oracle; seven architecture gates fail
red on real classes of drift; friction has a committed log; sync runs write a journal. The
remaining cost is concentrated in five places, and every one of them is measurable:

1. **Worktrees have a birth but no death.** 123 worktrees on jfedora and 33 on the Mac. 86 cargo
   `target/` directories here, 19 of them over 100 GB; 50 worktrees untouched since July. `just qa-gc`
   reaps devices, nothing reaps checkouts.
2. **Waiting is hand-rolled.** 15 of the 40 slowest tool calls across both machines are polling
   loops on a GitLab pipeline or a background agent's ledger, each running into the 10-minute tool
   timeout. There is no blocking `ci-wait`.
3. **Nothing is enforced at the harness layer.** Zero Claude Code hooks in the repo or in either
   machine's user settings. Every M-rule is prose plus, at best, a gate that scans instruction files.
   The open major papercut on process-name kills (`pc_44008fcf1d5a`) says exactly this.
4. **Mobile UI driving is the weakest verification link.** 40 of the 135 open papercuts are about
   driving iOS or Android: `axe` not installed, `describe-ios-ui` reporting "screen unknown" on every
   screen under iOS 26.5, a documented `--reboot` flag that `qa.mjs` never implemented, a software
   keyboard that hides for the rest of the boot after HID input, taps that land under the status bar.
5. **Friction is logged but not worked down.** 135 open papercuts, 8 of them major. The last
   `resolve` entry is 2026-08-20. Filing fell from 258 entries in August to 5 in September.

Everything below is either evidence for those five, the list of what an agent needs at each stage
of a task, or a fix with an effort estimate.

## 1. The evidence

| Measure                                              | jfedora                                                                                                                  | MacBook                                           | Source                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------------------- |
| Sessions / user turns / assistant messages           | 113 / 575 / 17,538                                                                                                       | 67 / 276 / 11,345                                 | `~/.claude/projects/*futo-notes*`             |
| Bash calls / error rate                              | 7,643 / 2.2%                                                                                                             | 4,477 / 2.1%                                      | same                                          |
| `just check` runs                                    | 157                                                                                                                      | 83                                                | same; warm run ≈ 45 s, cold worktree 2 m 02 s |
| Time waiting on the human (plan approval, pickers)   | 49 min (one `ExitPlanMode`)                                                                                              | 85 min (9 `AskUserQuestion`)                      | same                                          |
| Hand-rolled polling loops among the 40 slowest calls | 15                                                                                                                       | 6                                                 | same                                          |
| `sleep` calls blocked by the harness                 | 17 of 54                                                                                                                 | 9 of 25                                           | same (`Blocked: sleep N followed by …`)       |
| Subagents spawned                                    | 177 (86 general, 60 app-qa, 23 fixer)                                                                                    | 158 (53 general, 45 app-qa, 35 fixer, 18 Explore) | same                                          |
| Worktrees / cargo `target/` dirs                     | 123 / 86                                                                                                                 | 33 / 12+                                          | `git worktree list`, `du`                     |
| Worktrees merged into main but still present         | 7                                                                                                                        | not measured                                      | `git merge-base --is-ancestor`                |
| Worktrees with uncommitted changes                   | 32                                                                                                                       | not measured                                      | `git status --porcelain`                      |
| Largest `target/` dirs                               | 145, 139, 139, 139, 132 GB                                                                                               | 97, 89, 80 GB, seven × 30 GB                      | `du -sh`                                      |
| Disk                                                 | 1.4 TB of 1.9 TB used                                                                                                    | 289 GiB of 926 GiB free                           | `df`                                          |
| Papercuts open / major / resolved                    | 135 / 8 / 64                                                                                                             | (shared log)                                      | `.papercuts.jsonl`                            |
| Main pipeline wall time (last 8 green)               | 9–32 min, median ≈ 15 min                                                                                                |                                                   | GitLab API                                    |
| Longest CI jobs                                      | `test:ios-native` 10 m, `test:cross-platform-sync:android` 8 m, `build:ios-native` 7.5 m, `test:desktop-smoke:macos` 7 m |                                                   | GitLab API                                    |
| Last 60 pipelines, any ref                           | 21 success / 30 failed / 9 canceled                                                                                      |                                                   | GitLab API                                    |

Two caveats on the numbers. Session wall-clock sums (601 h here, 453 h on the Mac) overlap because
sessions run in parallel, so they are not hours spent. `du` on btrfs counts reflinked `target/`
clones at full size, so the per-directory sizes are real but the total is not additive; the
authoritative figure is `df`.

What the transcripts show agents doing when nothing is wrong: a session opens with `git worktree
add` + `pnpm install` (1 s here, thanks to the shared store), runs `just check` (2 m 02 s cold on 32
cores, including the first cargo build of `futo-notes-model` and `futo-notes-tauri` tests), and
then spends most of its time in the real app or waiting. The setup phase is already cheap on this
machine. The expensive phases are the ones after it.

## 2. What I need, stage by stage

Each row: what the stage needs, what exists, and the gap. "Have" means it works today in a fresh
worktree on both machines.

### 2.1 Orient (first 30 seconds)

- **Need:** one command that says which worktree and slot I am in, which ports and devices are
  mine, whether `node_modules` and `target/` are warm, what is dirty, which QA server is up, and
  which open papercuts touch the area I am about to work in.
- **Have:** `just ports`, `just qa-status`, `git status`, `papercuts list` — four commands, four
  formats, and nothing prints them unprompted.
- **Gap:** no orientation summary and no `SessionStart` hook to deliver it. Agents rediscover the
  slot model from `verify/SKILL.md` every session.

### 2.2 Build

- **Need:** a green baseline in minutes, on a warm cache when one exists nearby.
- **Have:** `just check` in 2 m 02 s from a cold worktree on jfedora; `just qa-clone-target` on
  macOS (APFS). `pnpm install` is 1 s here.
- **Gap:** no Linux equivalent of the clone (`cp --reflink=auto` on btrfs is the same one-liner);
  `qa-clone-target` is documented as macOS-only. Cold Rust for iOS on the Mac is ~10 minutes per the
  papercuts, and `test-ios-native` fails on a missing `node_modules/.bin/vite` only _after_ those 10
  minutes (`pc` 08-27). Fresh-worktree failures should fail in the first 5 seconds, not the last.

### 2.3 Run the real app without touching the real one

- **Need:** launch an isolated instance and prove it is mine.
- **Have:** the strongest part of the harness. `FUTO_NOTES_DATA_DIR`, `com.futo.notes.dev.wt<slot>`,
  `scripts/qa-target.mjs` (exit 3 on anything unsafe), `check-qa-input-safety` keeping the
  technique out of docs, `just qa-server` with a pinned SQLite server and no Docker.
- **Gap:** enforcement stops at the docs. A session that improvises OS input or a process-name kill
  from memory is only discouraged (`docs/architecture-gates.md` says so). Two Mac sessions in the
  transcripts got the user's "stop opening the app!!" — foregrounding a simulator or app during
  parallel work is the same class of problem and equally hookable.

### 2.4 Drive the UI

- **Need:** read the screen as structure, act on it by reference, get a definite answer about
  whether the action landed.
- **Have (desktop):** the Tauri MCP bridge — 140 `webview_execute_js` calls in the jfedora
  transcripts, the single most-used non-Bash tool. Loopback-only, slot-based port.
- **Have (Android):** `android-drive` with named debug hooks plus CDP for the editor WebView.
- **Have (iOS):** `simctl` + `axe` + `describe-ios-ui.mjs`.
- **Gap (desktop):** #115 — the bridge retargets unqualified calls to whichever app connected last.
  Every call must carry `appIdentifier`; nothing enforces it.
- **Gap (iOS):** the weakest link. `axe` absent on the Mac (`pc_d6d02599daa0`), `describe-ios-ui`
  reports "screen unknown (from no framed root) — 0 rows" for every screen on iOS 26.5
  (`pc_5fb25554deab`), HID typing hides the software keyboard for the rest of the boot
  (`pc_dd41a046601b`), headless-booted simulators return a 0×0 a11y root (`pc` 08-11), and the
  documented repair flag was never implemented (`pc_3c182ee6440d`). The iOS pre-push story gate fails
  on a pristine `origin/main` for the same keyboard reason (`pc` 08-31).
- **Gap (Android):** `android-drive tap` scrolls the target under the status bar (`pc` 08-17); a
  bare `&` in a label is eaten by `just` argument parsing (`pc_9b7fd5dba746`); no-args help exits 2.

### 2.5 Observe what the app did

- **Need:** after an action, read what actually happened: which bridge message arrived, which FFI
  call ran, what the watcher suppressed, how long a keystroke took.
- **Have:** `just journal` for desktop sync runs (stream 1 of the agentic-first plan); `just emu-logs`
  and `just sim-logs` tag greps; `window.__testSync`.
- **Gap:** journal streams 2–4 (editor latency, watcher, bridge/FFI) are unbuilt; native shells do
  not journal; desktop has no log tail (#41). M21 ("suspect the tool before the app") stays a
  heuristic because there is no bridge trace to look up.

### 2.6 Wait

- **Need:** block on a condition and get a structured answer when it resolves: a pipeline finishing,
  a subagent's ledger reaching a row, a simulator booting.
- **Have:** `Monitor` in the harness; `until` loops in the skills.
- **Gap:** no repo helper. The result is the polling loops in §1: 28 hand-rolled `for i in $(seq …)`
  and `until` loops per machine among the slow calls, most against the GitLab API, several against a
  sibling agent's ledger file, each capped at 10 minutes and then re-issued. The `sleep` family fails
  a third of the time because the harness blocks bare sleeps.

### 2.7 Gate

- **Need:** know which suite proves my change, run exactly that, and get a machine-readable verdict.
- **Have:** the per-layer chains in the nested `AGENTS.md` files; `just check` as the umbrella;
  `just prepush` as the maximal chain; the mid-tier is CI.
- **Gap:** the mapping from "files I touched" to "recipes I must run" lives only in prose
  (`verify/SKILL.md` step 1). Recipes end with a `tail -40`, not a verdict line. The 50% pipeline
  failure rate in the last 60 runs is partly intentional red-proofing, but nobody can tell from the
  API which failures were expected.

### 2.8 Hand off

- **Need:** survive my own death. A killed session's successor should inherit what was verified.
- **Have:** the incremental verdict ledger in `app-qa`, the run manifest in `verify-specs`,
  `test-screenshots/<leg>-ledger.md`.
- **Gap:** no ledger for ordinary fix work; a successor reads the diff and re-runs everything. The
  user's "5 background agents were stopped by the user" appears 11 times across the transcripts;
  each stop costs whatever those agents had not written down.

## 3. Recommendations

Ordered by value per hour. P1 items are each under a day and can land this week. Effort is an
honest guess for one session, verification included.

### P1 — this week

**P1.1 Worktree lifecycle: `just wt new` / `just wt gc`** — ½ day.
`new <name> [base=origin/main]`: `git fetch`, `git worktree add -b`, `pnpm install`, reflink-clone
`target/` from the primary checkout (`cp --reflink=auto` on btrfs, `cp -c` on APFS — fold
`qa-clone-target` in), print `just ports`. `gc`: dry-run by default; lists worktrees whose branch is
merged into `origin/main` or whose last commit is older than N days **and** whose tree is clean; only
`--apply` removes, and it never touches a dirty tree or the primary checkout. Prints the disk it
would free. Evidence: 123 worktrees, 7 already merged, 50 idle since July, 86 `target/` dirs, disk
at 74%. Verify: red-proof that a dirty worktree is never listed for removal; run against this
machine and report the freed bytes.

**P1.2 Shared hooks in `.claude/settings.json`** — 1 day.
Three hooks, each backed by a papercut or an M-rule that currently has no runtime guard:

- `PreToolUse` on `Bash`: deny the process-name kill pattern M25 bans, deny `git stash` inside a
  worktree (shared `refs/stash` restored another lane's WIP twice, `pc` 09-01 ×2), deny the
  OS-level input and app-activation commands the QA-input-safety gate already enumerates. The deny
  message names the sanctioned alternative (`just qa-target kill`, `git worktree`-local commit,
  the bridge). Reuse the regexes from `scripts/check-qa-input-safety.mjs` — one source of truth.
- `SessionStart`: run `node scripts/agent-orient.mjs` (new, P1.3) and inject its output.
- `SubagentStart`: export a per-agent scratch directory so parallel lanes stop overwriting each
  other's scratchpad files (`pc_e89422f7e382`, `pc` 08-31).

Hooks are project-scoped, so they apply in every worktree and to every subagent. Verify: a red
proof per deny rule (the hook must exit 2 and name the rule), plus a positive control showing a
sanctioned command passes.

**P1.3 `scripts/agent-orient.mjs`** — ½ day.
One JSON-and-text summary: worktree path, slot, the five ports, claimed devices (from `qa.mjs`),
QA server status, `node_modules` present, `target/` present and its size, dirty file count, branch
vs `origin/main` ahead/behind, and open papercuts whose tags match the top-level dirs in the diff.
Used by the `SessionStart` hook and callable as `just orient`. Evidence: §2.1.

**P1.4 `just ci-wait <sha|!mr>`** — ½ day.
Block until the pipeline for a sha (or an MR's head pipeline) reaches a terminal state, honoring a
`--timeout`; exit 0/1 by status; print failed job names with the last 40 lines of each failed job's
trace; `--json` for the whole thing. Add `just mr-status` that lists open MRs with head pipeline
status and draft flag in one line each. Evidence: §2.6, and the `glab` write-auth papercuts —
`curl` against the API with `$GITLAB_TOKEN` is what works from agent shells, so build on that.

**P1.5 Work the 8 open major papercuts and set a cadence** — 1 day for the sweep.
The eight, by id: `pc_44008fcf1d5a` (process-name kill guard → P1.2), `pc_d6d02599daa0` (axe
missing / idb works → P2.1), `pc_8d05793e3802` (Write/Edit normalizing U+0085/U+205F destroyed a
source file — document the ASCII-escape rule in `src/AGENTS.md`), `pc_fdd571c1ceb2` (unit job flakes
under CI CPU starvation: the 600-row FolderTreeView virtualization tests), `pc_8292d8962c74` and
`pc_5dc7e3957a8e` (long corpus sweeps need a detached, memory-aware, resumable recipe),
`pc_4f9a9539ecfe` (no way to reproduce CI's fsync profile locally), and the fourth-hour session
kill. Then schedule the gardener the agentic-first plan already specifies: a weekly scheduled
session that reads `papercuts list`, fixes what is docs/recipe-shaped in a dedicated worktree, and
opens one small MR. Evidence: §0 item 5.

**P1.6 Fail fresh-worktree preconditions first** — 2 hours.
`test-ios-native`, `build-ios-native`, `test-android-native`, and `gauntlet-*` all shell to
`node_modules/.bin/vite` or `pnpm exec` _after_ the Rust build. Add a two-line preflight at the top
of each (`[ -x node_modules/.bin/vite ] || { echo "run: just install"; exit 1; }`), and make
`build-rust-android.sh` honor `CARGO_TARGET_DIR` (`pc_b0e9c9e5f9f8`). Evidence: §2.2.

### P2 — next two weeks

**P2.1 Replace the iOS driving stack** — 2–3 days, Mac required.
Evaluate `agent-device` (callstack) and Maestro MCP against the current `axe` +
`describe-ios-ui.mjs` path on iOS 26.5. Both expose accessibility snapshots with element refs and
capture evidence; `agent-device` additionally scopes device claims to the git worktree, which is the
model `qa.mjs` already implements by hand. Acceptance: the `test-ios-stories` recipe passes on a
pristine `origin/main` from a pooled simulator, and `describe-ios-ui` (or its replacement) returns a
framed root on the note list, editor, and menu. Whichever wins, delete the loser's playbook section
and the phantom `--reboot` reference. Evidence: §2.4.

**P2.2 Make the MCP bridge target explicit (#115)** — ½ day.
Wrap `driver_session` / `webview_*` in the desktop playbook so `appIdentifier` is always the
worktree's `com.futo.notes.verify.s<slot>`, and file the upstream bug. Until then a `PreToolUse`
hook on `mcp___hypothesi_tauri-mcp-server__*` can deny calls missing `appIdentifier`. Evidence: #115
and the "misattributed FAIL" warning in `mr-qa/SKILL.md`.

**P2.3 Desktop log tail (#41) and journal stream 4** — 2 days.
`just logs` for the desktop instance of this worktree (tail the journal directory plus the Tauri
stdout the launcher already captures in `$TAURI_LOG`), and the bridge/FFI journal stream so "did
my tap land" becomes a lookup. Evidence: §2.5; M21.

**P2.4 A verdict line at the end of every test recipe** — 1 day.
Each `just test-*` and `just check` ends with one machine-parseable line: `RESULT <recipe> PASS|FAIL
<count> <duration>`. `just check --json` emits the set. Agents stop `tail -40`-ing and stop misreading
a pipe's exit status (M11 already bit once). Evidence: §2.7.

**P2.5 Close or narrow #48** — 1 hour.
`vite.config.ts` and `playwright.config.ts` already derive the web port from `slot.mjs`; the
cross-platform harness has its own band. Re-read the issue, confirm what is left (the Vitest jsdom
suites share nothing), and close it or reduce it to the remaining item.

**P2.6 Mac as a remote for macOS-only recipes** — 1 day.
`scripts/remote-test.mjs` runs Linux-portable recipes on jfedora from the Mac. The reverse is done
by hand every time an iOS build is needed from a Linux session: `ssh` loops, a throwaway worktree
the agent creates itself, and no `node` on the non-interactive `PATH`. Add a `--host mac` profile
(fnm activation, `xcrun` preflight, the same worktree lock and sha re-check) and a `just mac
<recipe>` wrapper. Evidence: the ssh retry loops and 4 `Operation timed out` errors in the Mac
transcripts; `pc` 08-26 "log in to jfedora and check in".

### P3 — bigger bets, each its own plan

- **One real end-to-end journey per platform in CI (#49).** The mobile apps still have zero
  runtime coverage in CI. This is the single largest gap between what CI proves and what ships.
- **Journal streams 2 and 3** (editor latency/startup, watcher decisions) with `perf-budgets.json`
  as the ratchet — already specified in the agentic-first plan.
- **Repeat the AGENTS.md ablation** once P1.2 lands: the 2026-08-06 experiment showed
  structure-backed rules survive without the prose and judgment rules do not. Hooks move several
  M-rules from prose to structure, which should show up as a measurable drop in the doc's needed
  size.

## 4. Stop doing

- **`AskUserQuestion` for choices.** 85 minutes of blocked wall-clock on the Mac in nine calls;
  Justin cannot arrow-key the picker. Lay options out as numbered text (already in the feedback
  memory; worth a line in the root `AGENTS.md` §11 so every session sees it).
- **Plan-mode approval as a gate on autonomous work.** One 49-minute `ExitPlanMode` wait on
  jfedora. For reversible in-repo work the manual already says act; plan mode is for scope changes.
- **Bare `sleep` polling.** Blocked by the harness a third of the time; use `Monitor` or the P1.4
  helper.
- **Creating worktrees under `.claude/worktrees/` with generated names.** 50 of the 123 are
  `agent-a…`/`wf_…` names nobody can map to a task. P1.1's `new <name>` takes a human-readable name
  and records the originating session id in `.git/worktrees/<name>/futo-purpose`.

## 5. How we work better together

- **Every session opens with the orientation line** (P1.3): worktree, slot, devices, dirty state.
  You should never have to ask "which checkout is this in?"
- **Long work leaves a ledger, not a promise.** Any task expected to outlive a context window writes
  `.futo/ledger.md` in its worktree (what was verified, with the command and result) so a killed
  session's successor resumes rather than restarts. This generalizes what `app-qa` and
  `verify-specs` already do.
- **Verification is reported as commands and results, never adjectives.** The verdict line (P2.4)
  makes that mechanical.
- **Friction goes to papercuts in the moment, and papercuts get a weekly owner** (P1.5). A log
  that is only written to is a diary.
- **Sessions that exceed the 5-hour limit park state first.** Already in the feedback memory; the
  ledger convention is how.
- **When the tool is silent, the tool is the first suspect (M21)**, and after P2.3 that suspicion
  becomes a journal query instead of a re-run.

## 6. What I checked and did not

Checked: both machines' transcripts end to end with the same script; every worktree's branch,
last commit, merge state, and dirtiness on jfedora; `target/` sizes on both machines; the last 60
pipelines and the per-job durations of the latest green main pipeline; a full cold `just check` in
this worktree (2 m 02 s, green); the papercuts log including which cuts have a matching resolve.

Not checked: Codex's own session logs (`~/.codex/sessions`), which the papercuts show Codex agents
filing from — their friction is in the log, their transcripts are not in this analysis. Not
measured: how often a green `just check` preceded a red pipeline, which would say how much of CI is
catching things local checks cannot. The social-media pass returned almost nothing from the last 30
days (the Reddit backend errored; X had one relevant post), so the outside-reading input is the
essays and tool docs named at the top, not community sentiment.

## 7. Proposed first MR set

1. `just wt new` / `just wt gc` + Linux reflink (P1.1, P1.6's `CARGO_TARGET_DIR` fix).
2. `agent-orient.mjs` + the three hooks (P1.2, P1.3).
3. `ci-wait` / `mr-status` (P1.4).
4. Papercut sweep of the 8 majors, scheduled gardener (P1.5).

Each lands with a red proof for what it guards, updates the recipe list in `justfile`, and adds
nothing to the root `AGENTS.md` except a pointer.
