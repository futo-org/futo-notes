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
it's 5–10× the cost of an MR pass.
