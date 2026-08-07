---
name: mr-qa
description: Parallel QA of merge requests across desktop/iOS/Android, including cross-client sync. Use when the user wants MRs or a branch tested — "test MR !123", "QA my open MRs", "test this branch on mobile" — or a full spec pass.
---

# MR QA — parallel by default

One MR = one worktree = one isolated stack (own pooled devices, own sync
server + database). QA several MRs **concurrently**; the `/verify` skill's
isolation model is what makes that safe.

## Before anything

- **Re-query the open-MR set** (`state=opened`, GitLab API with
  `$GITLAB_TOKEN`) at the start of every pass — it drifts mid-session; diff
  against what's already reviewed.
- **Probe host capability**: `xcrun` (iOS — absent on Linux, so iOS QA is
  impossible there), `adb devices` + `just qa-status` (Android pool), desktop
  (always available). Map each MR to the platforms its diff actually needs
  and state impossible coverage explicitly per MR — never silently drop it.
- **Route non-app MRs away from device QA.** A CI/infra-only MR (e.g.
  `.gitlab-ci.yml`) is verified by (a) a green pipeline on its head sha AND
  the specific job it fixes having actually run (not skipped by rules), and
  (b) a static review against AGENTS.md M11–M16. No app-qa agents.

## Per MR (pipelines run concurrently across MRs)

1. **Static gate first, across all worktrees at once, before any device
   build**: `tsc --noEmit` + the MR's targeted unit tests. Dependency bump →
   duplicate-dependency check (`find node_modules/.pnpm -maxdepth 1 -name
   '@codemirror+view@*'` — M22's blank-editor failure). Editor/CM change →
   `pnpm run test:markdown-spec` is the key gate, but it runs in Chromium —
   the agent must still confirm decorations live in Tauri's WebKit.
2. **Worktree**: resolve the MR's source branch, then
   `git worktree add .claude/worktrees/mr-<iid> origin/<branch>` and
   `pnpm install` (installs run concurrently across worktrees).
3. **Claim + pre-build — before spawning any agent.** The orchestrator eats
   every build wait; agents idling on cold builds get force-collected:
   - `just qa-claim` (from the worktree) → note the `SIM` / `ANDROID_SERIAL`
     exports.
   - `SIM=<udid> just ios-native` and `just android-native`, backgrounded;
     within one worktree they partially serialize on the cargo `target/`
     lock (queueing, not a hang); across worktrees they're fully parallel.
   - MR touches shared code (`src/`, `packages/`, `crates/`) or desktop →
     also launch the desktop app per `/verify`'s `references/desktop.md`
     (NOT `just tauri-dev` — its auto-started server collides with
     `qa-server` on the same slot port).
   - `just qa-server` if the pass includes sync (it usually should).
4. **Spawn one `app-qa` agent per MR** (model-pinned to Sonnet). Brief:
   worktree path, claimed device ids, server port/password, diff summary →
   spec surfaces, that apps are pre-built, and the three isolation traps
   below.
5. **Monitor — idle ≠ progress.** `idle_notification {reason: available}`
   fires both while an agent parks on a long cold build AND when it has
   stalled/died. On each idle (or on a timer) verify actual progress: a live
   build process (`pgrep -af "worktrees/mr-<iid>" | grep -E
   'cargo|gradle|tauri|vite'`) plus ledger movement (`stat` + tail of
   `.qa-ledger.md`). Idle + neither = stalled → re-engage once via
   `SendMessage`; on a second stall (two-strikes) take over the remaining
   checks yourself — the agent leaves its Tauri instances + qa-server
   running, so drive them directly (Tauri MCP `driver_session` /
   `webview_execute_js`) or run `pnpm run test:cross-platform`.
6. **Aggregate**: one verdict table per MR (stories + sync legs, with
   evidence paths), FAIL details quoting the spec, and a cross-MR isolation
   note (any collision finding is a bug in the isolation layer — report it
   loudly).
7. **Teardown per worktree**: `just qa-release --shutdown` (also stops that
   worktree's server), `just qa-server-stop --drop`, kill the desktop app if
   launched, then `git worktree remove` unless the user wants to iterate on
   that MR. `just qa-gc` reaps devices of deleted worktrees.

## Isolation traps (brief every agent up front — they recur)

1. **Slot-hash collision** — the canonical derivation in `scripts/lib/slot.mjs`
   can collide at ~5 concurrent worktrees (two worktrees → same slot: same Vite port + same
   `com.futo.notes.verify.s0` identifier, and `driver_session` silently
   reuses the *other* app). On any collision fall back to a unique
   identifier `com.futo.notes.verify.mr<iid>` + a manually picked free port.
   Related MCP trap: with >1 connected Tauri app the last-connected becomes
   the default, so unqualified `webview_execute_js`/`read_logs` calls land
   on another MR's app — always pass `appIdentifier: <port>` explicitly.
2. **`tests/cross-platform-sync.mjs` is NOT per-worktree isolated** — it
   shells to a machine-global Postgres container, so it deadlocks/401s under
   parallel load. Run it when contention is low, or mark it BLOCKED
   (pre-existing infra, not the MR).
3. **F-series `server_integration` needs `AUTH_MODE=dev`**, but
   `just qa-server` runs `AUTH_MODE=password` (correct for the mesh).
   Agents spin their own isolated dev-mode server for that suite.

## Scope and cost

Default to MR-scoped: map the diff to `docs/spec/<surface>.md` surfaces and
QA those, plus the cross-client sync smoke whenever the diff touches sync,
the shared Rust core, or the editor. A typical MR pass costs ~100–250k
output tokens (failures cost more than passes). The practical ceiling on
simultaneous MRs is RAM/CPU during overlapping cold builds — stagger the
build step past ~3 fresh worktrees.

**Full spec pass** (only when asked — 5–10× the cost of an MR pass): use the
parallel-leg topology in [`references/full-spec.md`](references/full-spec.md),
never sequential legs.
