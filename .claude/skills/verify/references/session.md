# QA session protocol

Read this before provisioning or driving an app in any QA workflow. The platform
playbooks in this directory own driver commands. `scripts/qa-target.mjs` owns desktop
identity; `scripts/lib/slot.mjs` owns port derivation; `just qa-claim` owns device claims.

## Isolation model (parallel sessions — read first)

One machine can run several QA sessions at once (different windows, different
MRs) using resources keyed on the **worktree**, with explicit collision checks:

- **One session per worktree.** Testing a different MR means a different git
  worktree — two sessions in one checkout collide at the working-tree level
  before any device is involved.
- The worktree path hashes to a **slot**; the slot derives ports, the pooled
  device, and the sync server + its database. Slots can collide; inspect existing claims and use the collision procedure below
  rather than assuming the derived ports are free.
- **The one thing NOT keyed on the worktree** is the user's installed release
  app: same binary name as every dev build, running on their real vault, and
  reachable by any OS-level input you send (which goes to the focused window,
  not to a process). Resolve desktop targets only via
  `node scripts/qa-target.mjs` — see `references/desktop.md` and M24.

Shell variables don't persist between Bash tool calls — **re-compute these at
the start of any block that needs them**. `scripts/lib/slot.mjs` owns the
derivation (stock macOS has no `md5sum`, so don't hand-roll it in shell);
`just ports` prints the whole map:

```bash
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
eval "$(node "$WORKTREE_ROOT/scripts/lib/slot.mjs" env)"   # SLOT, VITE_PORT, WEB_VITE_PORT, SYNC_PORT, CDP_PORT
TAURI_LOG="/tmp/tauri-verify-${SLOT}.log"
PID_FILE="/tmp/tauri-verify-${SLOT}.pid"
echo "Worktree: $WORKTREE_ROOT → Vite port $VITE_PORT, web port $WEB_VITE_PORT (slot $SLOT)"
```

`vite.config.ts` and `playwright.config.ts` derive the web port from the same
module, so a plain `pnpm run dev` or `playwright test` already lands on
`$WEB_VITE_PORT` with no flags. `$FUTO_DEV_PORT` pins it for a one-off run.

| Resource | Range / name | How |
|---|---|---|
| Tauri Vite (per worktree) | 5200–5249 | `just ports` (avoids 5173/5180–5182) |
| Web Vite (per worktree) | 5250–5299 | `just ports`; config-derived, no flags needed |
| MCP bridge (desktop) | 9223–9322 | loopback-only; per-worktree base (`just ports`), scans up; discover after launch |
| Android CDP forward | 9330–9379 | `just cdp-forward` prints `export CDP_PORT=…` |
| Sync server | 3100–3149 + own SQLite DB | `just qa-server` (see sync section) |
| Rust sync-integration servers | 3150–3199 (dev mode) and 3200–3249 (stand-in mode), each with its own SQLite DB | `just test-sync-integration` starts both, runs `server_integration` + `sse_live` against them, and stops both by PID |
| Cross-platform sync harness | 21000–25999, a band of 100 per worktree; each server gets its own SQLite DB in a temp dir | `pnpm run test:cross-platform`; it allocates from its own band and refuses a port someone else holds rather than adopting it |
| Sync port-ownership probes | 26000–26199, 4 per worktree | `vitest run tests/lib/sync-test-server.test.mjs` binds these itself (`probeBand` in `scripts/lib/slot.mjs`); nothing else should |
| iOS simulator / Android AVD | pool `futo-qa-0..6` per platform | `just qa-claim` prints `export SIM=…` / `export ANDROID_SERIAL=…` |
| Windows qemu VM | singleton | one session at a time |

**Devices**: `just qa-claim [ios|android|all]` claims this worktree's pooled
device — creating and booting it on first use — and prints the export lines.
Set `SIM` / `ANDROID_SERIAL` in every Bash block that drives a device: all
`sim-*` recipes and `apps/ios/run.sh` honor `$SIM`, and `adb` honors
`$ANDROID_SERIAL` natively. `just qa-status` shows who owns what,
`just qa-release` frees your claims when done, `just qa-gc` reaps devices
whose worktrees were deleted. Personal (non-pool) simulators/AVDs are never
touched. Driving a device you didn't claim is how two sessions end up
install-thrashing one emulator — don't.

> `just wt new <name>` does worktree + `pnpm install` + a reflinked warm
> `target/` in one step, and `just wt gc` reaps stale worktrees afterwards.
> When setting up several by hand, run `pnpm install` in all of them
> concurrently — separate `node_modules`, no conflicts, ~12s saved each.
> Then seed each with a warm cargo build via `just qa-clone-target
> <worktree>` (APFS copy-on-write clone of `target/` — seconds, near-zero
> real disk) so the first build isn't a cold workspace compile.

> **Within one worktree**, the iOS, Android, and desktop builds all compile
> the same Cargo workspace and share that worktree's `target/`, so launching
> them together partially serializes on cargo's build-dir lock — "Blocking
> waiting for file lock on build directory" is queueing, not a hang. Builds
> in **different** worktrees are fully parallel (separate `target/`).

## Two hard rules for driving apps under QA

Both were learned by damaging the user's real data. Brief every leg on both.

1. **Drive the desktop app only through the Tauri MCP bridge, with an explicit
   `appIdentifier`.** Never `osascript`/System Events keystrokes, never
   `cliclick`, never any other OS-level input — and never brief an agent to
   (a prior QA ledger did, which is how this happened). Every build shares the
   process name `futo-notes-tauri`, so a lookup by process name or unix id
   resolves to whatever instance the OS picked — it resolved to the installed
   production app, and a Cmd+Z landed in the user's live vault. OS-level input
   has no way to name which app it is talking to; the bridge does. Prefer
   in-page instrumentation (`webview_execute_js`, `window.__notesShellTest`,
   `window.__testSync` — `src/features/sync/testSync.ts`) to screen capture
   wherever the state is readable from the page. When a check genuinely needs
   real input plumbing (M21: DOM `click()` doesn't fire Svelte 5 handlers), use
   the bridge's `driver_session` or Playwright `page.keyboard` against the same
   code — not the OS. To turn a port or PID into something you may drive at all,
   use the one sanctioned resolver, `node scripts/qa-target.mjs list|pid|port`:
   it vets the executable's real path against this repo's worktree list plus the
   instance's data dir and vault, and exits 3 on anything else. *(This paragraph
   is the prohibition itself; `scripts/check-qa-input-safety.mjs` enforces it and
   pins these lines in `scripts/qa-input-safety-allowlist.json`.)*
2. **Never write into a shared vault.** A leg generates its test vault inside
   its own worktree, under that worktree's `FUTO_NOTES_DATA_DIR`. Never the
   user's real notes directory (M3), and never the machine-global dev
   `fake-notes` default either — two legs there scribble over each other and
   over whatever the user's own dev build is doing.

## Isolation traps (brief every agent up front — they recur)

1. **Slot-hash collision** — the canonical derivation in `scripts/lib/slot.mjs`
   can collide at ~5 concurrent worktrees (two worktrees → same slot: same
   Vite port + same `com.futo.notes.verify.s0` identifier, and
   `driver_session` silently reuses the *other* app). On any collision fall
   back to a unique identifier `com.futo.notes.verify.mr<iid>` + a manually
   picked free port. Related MCP trap: with >1 connected Tauri app the
   last-connected becomes the default, so unqualified
   `webview_execute_js`/`read_logs` calls land on another MR's app — always
   pass `appIdentifier: <port>` explicitly.
2. **`tests/cross-platform-sync.mjs` IS per-worktree isolated** — its port band
   comes from the worktree slot and every server gets its own SQLite database in
   its own temp directory, so parallel MRs no longer share state. It still runs
   real Tauri clients, so heavy parallel load can still starve timing-sensitive
   scenarios; when that happens, say so rather than reporting a sync defect.
3. **F-series `server_integration` needs `AUTH_MODE=dev`**, but
   `just qa-server` runs `AUTH_MODE=password` (correct for the mesh). Agents
   spin their own isolated dev-mode server for that suite.

## Provision a leg

1. Work in an isolated worktree for the commit under test; install dependencies with
   `just install`. Seed a warm Cargo target with `just qa-clone-target <worktree>`
   when supported by the host. Check for slot collisions before launching.
2. Claim the required platforms with `just qa-claim`, and preserve the printed device
   exports in the leg brief. Re-export them in every shell block that drives a device.
3. Build and launch through the platform playbook: `just ios-native`,
   `just android-native`, or `references/desktop.md` for desktop. Pre-build before
   handing a leg to an agent. Inside one worktree, native builds share Cargo's lock;
   across worktrees, they do not. Never assign concurrent legs the same device.
4. For sync, start `just qa-server` and record the URL, password, and seeded contents.
   This downloads the pinned server and uses SQLite; it requires neither Docker nor
   Postgres. Each password-mode server has one singleton account: every connected
   client merges into that vault. Separate unrelated stories by server, not by email.
5. Brief a leg with commit, worktree, platform, device exports, explicit desktop
   appIdentifier, surfaces, server details, seeded data, and an absolute ledger path.

## Execute and record

Derive stories from `docs/spec/<surface>.md`, including platform qualifiers. Known
`> **Gap:**` notes are SKIP-gap, not new defects. Before calling an affordance absent,
follow the hidden-affordance checklist in `docs/spec/AGENTS.md`.

Every verdict is a row: story id, spec line, PASS / FAIL / BLOCKED / SKIP-gap,
evidence path, and one-line explanation. Append it to the leg's ledger immediately.
A PASS needs rendered UI, disk contents, or logs that prove the claim; a spinner
alone proves nothing. BLOCKED means the environment could not exercise the story.
Before FAIL, attempt refutation from a clean state, a counter-probe, or an alternative
reading of the spec; record that attempt. Defect comparison and capture mechanics
are in `references/evidence.md`.

Resume only against the recorded commit and valid environment. Apply the evidence
reuse rules below; do not blindly skip every row that happens to exist in a ledger.
Report confirmed failures with expected behavior, actual behavior, and reproducible
steps. Record verified new divergences per `docs/spec/AGENTS.md`; recommend `/bugfix`
for regressions rather than silently changing product behavior during QA.

## Reusing a prior pass's evidence

A previous pass's ledger is an **input to a leg, never a substitute for one**.
It makes a leg cheaper by telling the agent what is already settled; it does
not remove the leg.

- Reuse requires the MR head sha to be byte-identical to the sha that evidence
  was recorded against, **and** the verdict to be cited as carried over with
  its date: `PASS (carried over, 2026-08-07 pass, head sha unchanged)`. An
  uncited carry-over is indistinguishable from fresh evidence, which is what
  makes it dangerous.
- Reuse never covers a story the prior pass left **BLOCKED, flaky, void,
  retracted, or "lower confidence"**. Those are precisely the unresolved ones;
  they get fresh work or the MR is NO SHIP (insufficient coverage).
- **An unchanged branch is not an unchanged merge result.** Main moved
  underneath it, so the merged state is new even when the diff is byte-for-byte
  the same. A carried-over PASS is evidence about the branch as it was tested,
  not about what merging it does today — re-run anything that could interact
  with what has landed on main since.

## Cross-client sync smoke

For shared editor, Rust core, or sync changes, connect this worktree's clients to
one isolated server: desktop/iOS simulator use loopback; Android emulator uses
`10.0.2.2`; physical devices need the host LAN address. Native clients connect via
Settings → Sync; the desktop dev bridge exposes `window.__testSync`.

Create a distinctive note on A, sync and verify it on B (and C), then edit on B and
verify the edit returns to A. Flush and read disk as well as checking the UI. Any
server content not declared in the brief is an isolation collision; report it.

## Teardown

Only release resources this session owns. From each worktree, `just qa-release --shutdown`
frees its device claims and stops its sync server. Drop disposable test data with
`just qa-server-stop --drop` only when the session created it and the user is done.
Stop desktop instances by `just qa-target kill` or the exact PID/process group this
session started. Preserve worktrees, ledgers, and manifests needed for iteration or
resume. Remove disposable worktrees only after checking for uncommitted work and
expensive state; never recursively delete a target cache as incidental QA cleanup.
