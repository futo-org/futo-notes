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
