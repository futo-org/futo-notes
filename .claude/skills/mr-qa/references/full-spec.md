# Full spec pass — parallel legs

Run legs across worktrees, not sequentially per platform (measured:
sequential ≈ 9.5h wall clock; this topology ≈ 3.5–4h on an M-series/32GB
machine). Pool capacity: 7 devices per platform, 50 port slots. Budget:
full spec on one platform (~80 stories) ≈ 400–500k output tokens; all three
platforms + sync mesh ≈ 1.2–1.6M.

1. **Worktrees**: main checkout + 3 extras (`git worktree add`;
   `pnpm install` in all concurrently). Seed each with a warm cargo build:
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
   the session limit is the ceiling, not the machine. Launch big waves right
   after a limit reset. app-qa agents write verdicts incrementally to a
   ledger file, so a mid-wave death costs a resume, not a rerun — pass a
   dead agent's ledger path to its replacement.
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
   agent — a device-barred Compose fix once shipped broken and cost a full
   extra verify+fix round. With several claimed devices, fixers iterate on
   one while verifiers drive another.
8. **Verify phase**: independent per-platform fix-verification agents rerun
   the exact QA repros, then `just check`.
9. **Teardown**: per worktree `just qa-release --shutdown` +
   `qa-server-stop --drop`, remove the extra worktrees (their cloned
   `target/` goes with them), `just qa-gc` for strays.
