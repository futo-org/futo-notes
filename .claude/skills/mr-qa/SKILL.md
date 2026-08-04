---
name: mr-qa
description: Parallel QA of one or more merge requests across desktop/iOS/Android, including cross-client sync. Use when the user wants MRs tested — "test MR !123", "QA these five MRs in parallel", "spin up QA for my open MRs", "test this branch on mobile" — or wants a full spec pass. Works the open MRs oldest-first and skips drafts. Creates a git worktree per MR for isolation, pre-builds, fans out one app-qa subagent per MR/platform leg concurrently, aggregates verdicts, and calls SHIP/NO SHIP on each — merging the SHIPs.
---

# MR QA — parallel by default

One MR = one worktree = one subagent = one isolated stack (own pooled
devices, own sync server + database). Several MRs are QA'd
**concurrently**; the isolation model in the `/verify` skill is what makes
that safe. Battle-tested 2026-07-02: two simultaneous full-stack passes,
zero cross-talk.

**Don't QA an MR in the main checkout, and don't give one agent two MRs.**
Both shortcuts feel faster and both cost more than they save. Checking an
MR branch out in the main tree strands whatever the user had in flight
there and re-invalidates the cargo/gradle caches on every switch, so the
"saved" worktree setup gets paid back as cold builds. And one agent
holding two MRs will eventually attribute one MR's failure to the other —
that has already happened here (see the `driver_session` default-app trap
below), and a misattributed FAIL costs a re-run plus the credibility of
the rest of the report. A worktree is `git worktree add` + `pnpm install`;
a subagent is one tool call. Neither is worth economizing on.

So prefer more, smaller subagents over one long-lived one: give each
`app-qa` agent a single (MR × platform) leg. Its context then stays about
one diff on one device, which is what keeps its judgment about that diff
sharp — and a session-limit death takes out one leg instead of the pass.

## Pick the MR set — oldest first, drafts skipped

Work **oldest → newest** by MR iid. Old MRs have had the most time to rot:
their branch has drifted furthest from main, they're the likeliest to need
a conflict resolved, and their author has been waiting longest. Landing
them in that order also shrinks the diff every younger MR must rebase
over, so later MRs get cheaper as you go.

Skip drafts. GitLab exposes the flag as `"draft": true` (the title also
carries the `Draft:` prefix) — it's the author explicitly saying "not
ready", and a device pass on code that's about to change is the most
expensive kind of wasted run. Name the skipped drafts in the report so the
user can see they were considered, not overlooked.

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/merge_requests?state=opened&order_by=created_at&sort=asc&per_page=100" \
  | jq -r '.[] | select(.draft == false) | "\(.iid)\t\(.source_branch)\t\(.title)"'
```

Ordering governs the *sequence you start* legs in, not a serialization —
once launched they still run concurrently, and the oldest MR simply gets
first claim on devices and build slots. If the user names specific MRs,
honor their list, but still start oldest-first and still flag any draft
among them (they may not know it's marked one). Re-query before every pass
— the open set drifts mid-session (see the learnings below).

## Per MR (run these pipelines concurrently across MRs)

1. **Worktree**: resolve the MR's source branch (GitLab API; `$GITLAB_TOKEN` is
   already in the shell —
   `curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/merge_requests/<iid>"`),
   then
   `git worktree add .claude/worktrees/mr-<iid> origin/<branch>` and
   `pnpm install` (installs across worktrees can run concurrently).
2. **Claim + pre-build — before spawning any agent.** Agents that idle-wait
   on cold builds get their output force-collected; the orchestrator eats
   the wait instead:
   - `just qa-claim` (from the worktree) → note the `SIM` / `ANDROID_SERIAL`
     exports.
   - `SIM=<udid> just ios-native` and `just android-native` — background
     them; within ONE worktree they partially serialize on the cargo
     `target/` lock (that's queueing, not a hang); across worktrees they're
     fully parallel.
   - When the MR touches shared code (`src/`, `packages/`, `crates/`) or
     desktop, also launch the desktop app per the `/verify` skill's
     `references/desktop.md` (it isolates data via `FUTO_NOTES_DATA_DIR`;
     do NOT use `just tauri-dev` here — its auto-started server would
     collide with `qa-server` on the same slot port).
   - `just qa-server` if the pass includes sync (it usually should).
3. **Spawn one `app-qa` agent per MR.** Hand it: the worktree path, the
   claimed device ids, the server port/password, what the MR changes (diff
   summary → spec surfaces), and that apps are pre-built. Agents for
   different MRs run concurrently.

   `app-qa` is pinned to Sonnet on purpose — a QA leg is long, tool-heavy,
   and shallow per step (tap a label, read the a11y tree, compare to one
   spec line), so a bigger model buys little. Its real failure mode is M21
   (believing `axe tap`'s success or a stale screencap), which the
   pre-brief in the learnings below addresses and a model upgrade would
   not. What stays on the orchestrator's model is the judgment work, where
   being wrong propagates: mapping the diff to spec surfaces, deciding a
   FAIL belongs to the MR rather than the isolation layer, and declaring
   coverage impossible. Hand fixes to `fixer` (Opus-pinned) rather than
   asking a QA leg to fix what it found — a wrong fix is the most
   expensive thing this pipeline can emit.
4. **Aggregate**: one verdict table per MR (stories + sync-mesh legs, with
   evidence paths), FAIL details quoting the spec, and a cross-MR isolation
   note (any collision finding is a bug in the isolation layer — report it
   loudly).
5. **Call SHIP or NO SHIP on every MR, then land the SHIPs** — see below.
6. **Teardown per worktree**: `just qa-release --shutdown` (also stops that
   worktree's server), `just qa-server-stop --drop`, kill the desktop app if
   launched, then `git worktree remove` unless the user wants to iterate on
   that MR. Pool devices persist unclaimed for instant reuse; `just qa-gc`
   reaps devices belonging to deleted worktrees.

## SHIP / NO SHIP — and merging the SHIPs

Every MR in the pass gets an explicit **SHIP** or **NO SHIP** line. A pass
that ends in a wall of evidence and no verdict pushes the decision back
onto the user, which is the one thing the QA pass existed to take off their
plate. If the evidence genuinely doesn't support a call, that is itself a
verdict — **NO SHIP (insufficient coverage)** — and it should name the leg
that was blocked rather than hedging.

**A SHIP is authorization to merge it.** Don't stop to ask; merge, then
report what landed. Merge the SHIPs oldest-first, one at a time, re-checking
the next MR's mergeability after each — landing an old MR is exactly what
puts a younger one into conflict.

SHIP requires all of these. Any one missing makes it NO SHIP, not a
judgment call:

- No unexplained FAIL. A FAIL is either fixed on the branch, or shown to be
  pre-existing on main / an infra flake **with the evidence for that claim**
  (reproduce it on main; "probably the isolation layer" is not evidence).
- Coverage actually matched the diff. An `apps/ios` MR whose iOS leg was
  impossible is NO SHIP (insufficient coverage), however clean the desktop
  leg looked — see the Tailscale Mac probe below before concluding iOS was
  impossible.
- GitLab says it can merge: green pipeline **on the head sha**, no
  conflicts, no unresolved discussion threads, not a draft.
- `just check` passes in the MR's worktree if the diff touches shared code.

**Ask before merging, even on a SHIP**, when the MR touches anything on
AGENTS.md's stop-and-ask list — `keys/`, the updater trust boundary, a
CRITICAL guard (dev bundle id, `fake-notes` root, push-first sync,
`release:gate.needs`, the dep-guard, `hash.rs`), anything that publishes,
or a cross-cutting protocol change (sync payload, `BRIDGE_VERSION`,
`AppState` schema). A clean QA pass says the code behaves; it doesn't
say the trust boundary or the wire format should move. Report those as
**SHIP (needs your merge)** with the reason, and leave them open.

For a NO SHIP, say what would flip it — a fix, a rerun on a specific
platform, or a decision only the user can make. Hand fixable ones to
`fixer` if the user asked for fixes; otherwise leave the finding on the MR
as a comment so the author has it.

## Learnings from practice (added 2026-07-08, 7-MR run on a Linux host)

- **Check host capability before choosing a topology.** The pool/topology
  assume an M-series Mac. On a **Linux host there is no local Xcode**
  (`xcrun` absent). First probe: `xcrun` (iOS), `adb devices` +
  `just qa-status` (Android pool), desktop (always available on Linux). Map
  each MR to the platforms its diff actually needs and state impossible
  coverage **explicitly per-MR** in the report — don't silently drop it.

- **From Linux, try the Mac over Tailscale before writing iOS off.** Justin's
  Mac is often reachable as `justins-macbook-pro` (`ssh justin@100.101.132.29`)
  — probe it with a cheap `ssh -o ConnectTimeout=5 … 'xcrun -f xcodebuild'`
  rather than assuming either way; it's a laptop, so it's sometimes asleep or
  off-net. When it answers, iOS compile checks and `just test-ios-native` are
  back on the table, which is worth a lot on an MR touching `apps/ios` or the
  FFI. Treat that checkout as someone else's desk: `git status` first, do the
  work in a throwaway `git worktree add /tmp/mr-<iid>-verify <branch>`, and
  `git worktree remove` after — never switch its working tree. Simulator QA
  over SSH is more limited than sitting at the machine (no GUI Simulator
  window), so scope the remote leg to builds, unit tests, and `simctl`-driven
  checks, and say in the report which iOS coverage was remote vs. absent.

- **Idle ≠ progress — never passively wait on `idle_notification`s.** app-qa
  agents emit `idle_notification {reason: available}` BOTH while parked on a
  long cold build AND when they have stalled/died; the signal does not
  distinguish them. Passively waiting will hang the whole run (it did this
  run). On each idle — or on a timer — verify **actual** progress:
  `pgrep -af "worktrees/mr-<iid>" | grep -E 'cargo|gradle|tauri|vite'` for a
  live build, plus `stat -c %y .../.qa-ledger.md` + tail for ledger movement.
  Idle + no matching process + no ledger movement = **stalled**. Re-engage
  once via `SendMessage`; on a **second stall (two-strikes), take over the
  remaining checks yourself** — the agent leaves its Tauri instances +
  qa-server running, so drive them directly (Tauri MCP
  `driver_session`/`webview_execute_js`) or just run
  `pnpm run test:cross-platform` (it spins its own instances). This run's !43
  mesh result (26/26) came from an orchestrator takeover after two stalls.

- **Pre-empt the three isolation-layer bugs in the agent brief** (they recur;
  tell every agent up front so they don't burn time rediscovering):
  1. **Slot-hash collision** — `/verify`'s `md5(worktree_path)%50` collides at
     ~5 concurrent worktrees (mr-40 ↔ mr-42 both → slot 0: same Vite 5200 +
     identifier `com.futo.notes.verify.s0`, and `driver_session` silently
     reused the *other* app). Brief agents to fall back to a **unique
     identifier `com.futo.notes.verify.mr<iid>` + a manually-picked free
     port** on any collision. (Infra fix: widen slot space or hash path+PID.)
     Related MCP trap: when >1 Tauri app is connected via `driver_session`,
     the **last-connected becomes the "default"** and un-qualified
     `webview_execute_js`/`read_logs` calls hit it — so an agent's actions and
     log reads can silently land on **another MR's app** (mr-44 read mr-45's
     console error as its own this run). Always pass `appIdentifier: <port>`
     explicitly once more than one app may be connected.
  2. **`tests/cross-platform-sync.mjs` is NOT per-worktree isolated** — it
     shells to a **machine-global** Postgres container (no slot namespacing,
     unlike qa-server), so it deadlocks/401s under parallel load. Expect it
     BLOCKED during high concurrency; run it when contention is low, or mark
     BLOCKED (pre-existing infra, not the MR).
  3. **F-series `server_integration` needs `AUTH_MODE=dev`** but `just
     qa-server` runs `AUTH_MODE=password` (correct for the mesh — native
     shells have no email field). Agents must spin their **own** isolated
     dev-mode server for the F-series suite.

- **Route non-app MRs away from device QA.** An MR touching only CI/infra
  (e.g. `.gitlab-ci.yml`) is **not** device QA. Verify by (a) confirming a
  **green pipeline on the MR head sha** AND that the **specific job the MR
  fixes actually ran** (not skipped by rules), and (b) a static review
  against the repo's CI failure classes (AGENTS.md M11–M16). Do not spin up
  app-qa agents. (!46 this run: pipeline on head sha, `test:rust:workspace` =
  SUCCESS, self-triggered via its own `changes: .gitlab-ci.yml` rule.)

- **Cheap static gate first, concurrently, before any device build.** Across
  all worktrees at once: `tsc --noEmit` + the MR's targeted unit tests. For a
  **dependency bump**, add a duplicate-dependency check
  (`find node_modules/.pnpm -maxdepth 1 -name '@codemirror+view@*'` — M22's
  blank-editor failure mode). For an editor/CM change the **markdown-spec
  corpus** (`pnpm run test:markdown-spec`) is the key gate but runs in
  **Chromium** — the agent must still confirm decorations live in Tauri's
  **WebKit**. Seconds of signal that shrink what the expensive builds prove.

- **Re-query open MRs at the start of every pass.** The open set drifts
  mid-session (this run: !43 merged, !44–!46 appeared between passes).
  Re-list `state=opened` and diff against what's already reviewed rather than
  trusting an earlier enumeration.

## Capacity and budgets (measured 2026-07)

- Device pool: 7 per platform; port slots: 50. The practical ceiling for
  simultaneous MRs is RAM/CPU during overlapping cold builds — stagger the
  build step when running more than ~3 fresh worktrees at once.
- Typical MR-scoped pass: **~100–250k output tokens**. Full spec on one
  platform (~80 stories): ~400–500k. Full spec, all three platforms + sync
  mesh: ~1.2–1.6M. Failures cost more than passes (investigation).

## Scope guidance

Default to MR-scoped: map the diff to `docs/spec/<surface>.md` surfaces and
QA those, plus the cross-client sync smoke whenever the diff touches sync,
the shared Rust core, or the editor. Only run the full spec when asked —
it's 5–10× the cost of an MR pass; when asked, use the parallel-leg
topology below, not sequential legs.

## Full spec pass — parallel legs (opt-in)

Run legs across worktrees, not sequentially per platform. Measured
2026-07-02: sequential legs made the pass ~9.5h wall clock; this topology
targets ~3.5–4h on an M-series/32GB machine.

1. **Worktrees**: main checkout + 3 extras (`git worktree add`; `pnpm
   install` in all of them concurrently). Seed each with a warm cargo build:
   `just qa-clone-target <worktree>` from the built checkout (APFS
   copy-on-write — seconds, near-zero real disk).
2. **Devices**: each worktree runs its own `just qa-claim`. RAM budget on
   32GB: 3–4 iOS sims fine; cap Android at **2 concurrent emulators while
   anything is building** (3 in steady state); desktop instances are cheap.
3. **Builds**: serialize the iOS installs (xcodebuild is the CPU hog);
   overlap gradle + desktop launches. The orchestrator eats every build wait
   BEFORE spawning agents.
4. **Legs**: one app-qa agent per (platform × surface-group), each pinned to
   its own worktree + devices. Surface groups: editor+app / list+nav(+tabs)
   / search+settings+settings-visual+sync-single-client. iOS ×3 and desktop
   ×3 fully parallel; Android 2 then 1. The cross-client **mesh runs
   concurrently** on the main worktree's stack — it does not wait for
   platform legs.
5. **Quota-aware waves**: 8–9 concurrent QA agents burn ~2.5M tokens/hour —
   the machine won't blink, the session limit will (5 agents died to it
   2026-07-02). Launch big waves right after a limit reset; app-qa agents
   write verdicts incrementally to a ledger file, so a mid-wave death costs
   a resume, not a rerun — pass a dead agent's ledger path to its
   replacement.
6. **Sync-server truth**: `auth_mode=password` means ONE singleton account
   per server — clients sharing a server share one merged vault, so
   per-"account" isolation between legs is impossible. Give sync legs their
   own slot's server or `just qa-server-stop --drop && just qa-server`
   between them, and TELL every connecting agent exactly what already lives
   on that server (undocumented objects get reported as collisions —
   correctly).
7. **Fix phase**: report-only QA legs → fixer agents on disjoint file sets.
   A fix whose mechanism is runtime-behavioral (Compose recomposition,
   scroll anchoring, focus/IME timing) MUST get device access in the same
   agent — a device-barred Compose fix shipped broken on 2026-07-02 and
   cost a full extra verify+fix round. With several claimed devices, fixers
   iterate on one while verifiers drive another.
8. **Verify phase**: independent per-platform fix-verification agents rerun
   the exact QA repros (this caught that broken fix), then `just check`.
9. **Teardown**: per worktree `just qa-release --shutdown` +
   `qa-server-stop --drop`, remove the extra worktrees (their cloned
   `target/` goes with them), `just qa-gc` for strays.
