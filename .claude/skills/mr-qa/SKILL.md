---
name: mr-qa
description: Parallel QA of one or more merge requests across desktop/iOS/Android, including cross-client sync. Use when the user wants MRs tested — "test MR !123", "QA these five MRs in parallel", "spin up QA for my open MRs", "test this branch on mobile" — or wants a full spec pass. Creates a worktree per MR, pre-builds, fans out app-qa agents concurrently, and aggregates verdicts.
---

# MR QA — parallel by default

One MR = one worktree = one isolated stack (own pooled devices, own sync
server + database). Several MRs are QA'd **concurrently**; the isolation
model in the `/verify` skill is what makes that safe. Battle-tested
2026-07-02: two simultaneous full-stack passes, zero cross-talk.

## Per MR (run these pipelines concurrently across MRs)

1. **Worktree**: resolve the MR's source branch (GitLab API with
   `$GITLAB_TOKEN` — see AGENTS.md "GitLab CI"), then
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
3. **Spawn one `app-qa` agent per MR** (they're model-pinned to Sonnet).
   Hand it: the worktree path, the claimed device ids, the server
   port/password, what the MR changes (diff summary → spec surfaces), and
   that apps are pre-built. Agents for different MRs run concurrently.
4. **Aggregate**: one verdict table per MR (stories + sync-mesh legs, with
   evidence paths), FAIL details quoting the spec, and a cross-MR isolation
   note (any collision finding is a bug in the isolation layer — report it
   loudly).
5. **Teardown per worktree**: `just qa-release --shutdown` (also stops that
   worktree's server), `just qa-server-stop --drop`, kill the desktop app if
   launched, then `git worktree remove` unless the user wants to iterate on
   that MR. Pool devices persist unclaimed for instant reuse; `just qa-gc`
   reaps devices belonging to deleted worktrees.

## Learnings from practice (added 2026-07-08, 7-MR run on a Linux host)

- **Check host capability before choosing a topology.** The pool/topology
  assume an M-series Mac. On a **Linux host there is no Xcode → iOS QA is
  impossible** (`xcrun` absent). First probe: `xcrun` (iOS), `adb devices` +
  `just qa-status` (Android pool), desktop (always available on Linux). Map
  each MR to the platforms its diff actually needs and state impossible
  coverage **explicitly per-MR** in the report — don't silently drop it.

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
