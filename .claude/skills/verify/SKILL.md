---
name: verify
description: Run the appropriate verification chain for recent changes. Detects what changed and runs build, tests, smoke checks, and visual UI verification. Use when the user says "verify", "check this", "does it work", "test it", "make sure X works", or after completing a feature/fix. Also use whenever the user wants to see a change running for real on ANY platform — the desktop Tauri app, the web dev server, the native iOS app on a simulator, the native Android app on an emulator/device, or Windows WebView2 in the qemu VM — including requests like "run it on the simulator", "screenshot the app on Android", or verifying a specific feature regardless of recent changes.
---

# Verify

Two modes: **change verification** (what did I break?) and **feature
verification** (does X work?). Detect which mode from context, run the right
checks, visually verify UI when applicable. Report clearly.

- **Change verification** — "verify", "check this", "does it work" after
  making changes. Detect what changed (Step 1), run matching chains.
- **Feature verification** — "verify wikilinks work", "test the editor on
  iOS". Skip diff detection; pick the suites and UI flows that cover the
  feature, run those, and do a hands-on UI check (Step 3) if user-facing.

The per-platform UI playbooks live in `references/` next to this file — read
the one you need before driving that platform:

| Platform | When | Playbook |
|---|---|---|
| Web dev server | pure CSS / markdown / CM6 decorations, no Tauri APIs | `references/desktop.md` |
| Tauri desktop | default for desktop features; anything touching Rust/`invoke()`/platform APIs | `references/desktop.md` |
| iOS simulator (native SwiftUI) | `apps/ios` changes, iOS-specific behavior, "on the simulator" | `references/ios.md` |
| Android emulator (native Compose) | `apps/android` changes, Android-specific behavior (IME, status bar) | `references/android.md` |
| Windows qemu VM (WebView2) | `#[cfg(windows)]`, native DnD, NSIS installer, clean-machine launch | `references/windows-vm.md` |

**Mobile is native, not Tauri**: the shipping mobile apps are the SwiftUI and
Compose shells on the shared Rust core. Neither has the MCP bridge — the
bridge is desktop-only. iOS is driven with `simctl` + `idb`, Android with
`adb` + CDP.

**Platform matrix** (`uname -s`): macOS = iOS + Android + desktop; Linux =
Android + desktop + the Windows qemu VM (no iOS). The playbooks note the few
OS-specific bits (Wayland env vars, SDK paths).

## Isolation model (parallel sessions — read first)

One machine can run several QA sessions at once (different windows, different
MRs) without collisions, because every shared resource is keyed on the
**worktree**:

- **One session per worktree.** Testing a different MR means a different git
  worktree — two sessions in one checkout collide at the working-tree level
  before any device is involved.
- The worktree path hashes to a **slot**; the slot derives ports, the pooled
  device, and the sync server + its database. Nothing needs a registry to
  stay "free" — no other session will ever target your slot's resources.

Shell variables don't persist between Bash tool calls — **re-compute these at
the start of any block that needs them** (Linux and modern macOS both ship
`md5sum`):

```bash
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
SLOT=$(( $(printf "%d" "0x$(echo -n "$WORKTREE_ROOT" | md5sum | cut -c1-8)") % 50 ))
VITE_PORT=$(( 5200 + SLOT ))
WEB_VITE_PORT=$(( 5250 + SLOT ))
TAURI_LOG="/tmp/tauri-verify-${SLOT}.log"
PID_FILE="/tmp/tauri-verify-${SLOT}.pid"
echo "Worktree: $WORKTREE_ROOT → Vite port $VITE_PORT, web port $WEB_VITE_PORT (slot $SLOT)"
```

| Resource | Range / name | How |
|---|---|---|
| Tauri Vite (per worktree) | 5200–5249 | computed above (avoids 5173/5180–5182) |
| Web Vite (per worktree) | 5250–5299 | computed above |
| MCP bridge (desktop) | 9223–9322 | plugin auto-scans; discover after launch |
| Android CDP forward | 9330–9379 | `just cdp-forward` prints `export CDP_PORT=…` |
| Sync server | 3100–3149 + own Postgres DB | `just qa-server` (see sync section) |
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

> When setting up multiple worktrees, run `pnpm install` in all of them
> concurrently — separate `node_modules`, no conflicts, ~12s saved each.

> **Within one worktree**, the iOS, Android, and desktop builds all compile
> the same Cargo workspace and share that worktree's `target/`, so launching
> them together partially serializes on cargo's build-dir lock — "Blocking
> waiting for file lock on build directory" is queueing, not a hang. Builds
> in **different** worktrees are fully parallel (separate `target/`).

## Step 1: Detect what changed (change verification mode only)

```bash
{ git diff --name-only HEAD~1 HEAD 2>/dev/null; git diff --name-only --cached; git diff --name-only; } | sort -u
```

If nothing changed, tell the user and stop. Categorize into ALL matching
categories — a change can match several; run every matching chain:

| Pattern | Category |
|---|---|
| `src/**/*.svelte`, `src/**/*.ts` (not tests) | frontend — if files import `@tauri-apps/*`/`invoke`/`rustCore`, also tauri-dependent; if editor-related, the same code ships inside the native apps' embedded editor |
| `src/**/*.css`, `src/styles/**` | styles |
| `src/**/*.test.ts`, `src/**/*.spec.ts` | unit-tests |
| `packages/shared/**` | shared |
| `packages/editor/**` | editor — feeds desktop AND the native shells' embedded editor.html; toolbar manifest changes also regenerate native toolbar specs |
| `crates/**` | rust-core — consumed by the Tauri app and (via `futo-notes-ffi`) both native shells |
| `apps/tauri/src-tauri/**` | tauri-rust |
| `apps/ios/**` | ios-native |
| `apps/android/**` | android-native |
| `tests/**` | playwright-tests |
| `docs/spec/**` | spec |
| `.gitlab-ci.yml` | ci |

## Step 2: Run verification chains

Run the build once upfront if any chain needs it, then the test suites. Stop
and report on first failure. (The sync server is a separate repo now — there
is no server code in this repo to verify; see "Features that need a sync
server" for standing one up.)

### Always (unless only CI/spec files changed):
```bash
pnpm exec tsc --noEmit 2>&1 | head -30
```

### frontend, styles, or unit-testable logic:
```bash
just build 2>&1 | tail -20
```

### frontend or styles — Playwright specs:
```bash
grep -rl '<feature-keyword>' tests/*.spec.ts   # find relevant specs
pnpm run test 2>&1 | tail -40                  # or run the matching specs only
```

### shared: `just test-shared 2>&1 | tail -20`
### unit-tests: `just test-unit 2>&1 | tail -30`
### editor: `just test-markdown-spec 2>&1 | tail -20` and `just toolbar-spec-check` (toolbar manifest changes)
### rust-core:
```bash
just test-rust 2>&1 | tail -20        # conformance (fast); broad changes: just test-rust-full
```
Rust changes reach the native shells through the ffi — if the change touches
`futo-notes-ffi` or the note domain, also compile-check a native shell (below).

### tauri-rust:
```bash
cd apps/tauri/src-tauri && cargo test 2>&1 | tail -30
```

### ios-native:
```bash
just build-ios-native 2>&1 | tail -5    # compile sanity (simulator, no signing)
just lint-swift                          # hand-written Swift style
# No unit-test target yet (justfile test-ios-native explains); UI-verify instead.
```

### android-native:
```bash
just test-android-native 2>&1 | tail -20   # JVM unit tests (builds ffi bindings first)
# or compile-only: just build-android-native
```

### spec: `just spec-gaps-check` (stale rollup / closure probes) — part of `just check` too.

### ci:
```bash
BRANCH=$(git branch --show-current)
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/pipelines?ref=$BRANCH&per_page=1"
```

## Step 3: UI Verification

When changes affect anything user-facing — or when verifying a user-facing
feature — see it running in the actual app. Pick the platform from the table
at the top and **read its playbook in `references/` first**. Skip only for
test-only or CI-only changes.

**"Invisible" behavior still needs verification.** Fire-and-forget calls,
warmups, prefetches — no visible UI change means you verify via a different
signal (console/bridge logs, server logs, files on disk), not that you skip.
For server-side changes, launch the app and confirm the client actually hits
the new endpoint.

```bash
mkdir -p ./test-screenshots
```

Name screenshots descriptively: `web-editor-heading-decoration.png`,
`android-dark-theme-sidebar.png`, `ios-swipe-actions.png`.

### Choosing web vs Tauri (desktop changes)

The web dev server stubs ALL Tauri commands. Check whether changed frontend
files depend on Tauri APIs:

```bash
grep -rl 'invoke\|@tauri-apps\|rustCore' $(git diff --name-only HEAD~1 HEAD 2>/dev/null; git diff --name-only --cached; git diff --name-only) 2>/dev/null | grep -E '\.(ts|svelte)$' | sort -u
```

Any match → Tauri. No match and purely CSS/markdown/CodeMirror decorations →
web is acceptable. Unsure → Tauri.

### Editor changes ship to three apps

The embedded editor (`editor.html`, built from the shared editor code) runs
on desktop AND inside both native shells. For editor-visible changes, verify
on desktop first (fast), then spot-check one native shell — `just ios-native`
/ `just android-native` rebuild the editor bundle automatically.

### Handling loading/async states in screenshots

A screenshot of a spinner is not verification. If a loading state is visible:
wait 5s, re-screenshot, repeat up to 6 times (30s total). Resolved → capture
the final render. Still stuck after 30s → report as **STUCK** and
investigate via the platform's log channel. Every verified feature needs at
least one screenshot of the actual rendered UI.

### Features that require app restart

Crash-dialog-on-relaunch, preference recovery, scan-on-launch behaviors only
manifest after a restart: trigger the precondition → kill/terminate the app
(platform playbook has the command) → relaunch → verify. Don't skip these;
they break most often.

### Features that need a sync server

`just qa-server` starts **this worktree's isolated server**: a bun process on
port `3100 + slot` with its **own Postgres database** (`futo_notes_qa_s<slot>`)
and blob dir. The per-slot database matters: test tooling TRUNCATEs its
tables, so parallel sessions sharing one database would wipe each other
mid-run. Password: `testing123`. Stop with `just qa-server-stop` (`--drop`
also drops the database).

Prereqs: the sibling server repo (set `FUTO_NOTES_E2EE_SERVER_REPO` when it's
not at `~/Developer/futo-notes-server`) + any reachable Postgres — the
recipe tries the repo's `docker compose up -d postgres` itself; a native
Postgres works too via `FUTO_NOTES_QA_PG=postgres://user:pass@localhost:5432`.

- **Client sync-stack changes**: prefer `just test-cross-platform` — it boots
  two real Tauri instances plus a fresh server per scenario by itself.
- **No Docker/Postgres available** (true of some QA machines): record sync
  happy-path stories as **Blocked**, not failed — the deeper sync logic is
  already covered by cross-platform + server-side suites.
- Reaching the server: desktop/iOS-simulator use `http://127.0.0.1:<port>`;
  the **Android emulator needs `http://10.0.2.2:<port>`**; physical devices
  need the machine's LAN IP.
- Connecting: the Tauri **dev** webview exposes `window.__testSync` (connect/
  status/syncNow/disconnect — see AGENTS.md "Browser Tools"); the native
  shells have no such hook — use Settings → Sync in the app UI.

After connecting + syncing: check the sync toast count, wait for indexing
(`GET /search/status` → `idle`, dirty 0), confirm the feature under test.

### What to look for

- **Editor**: open a note, type, verify decorations/widgets render
- **Theme/styles**: toggle light/dark (`just sim-appearance dark` on iOS),
  check contrast, no broken layouts
- **Navigation**: sidebar/list, note switching, back, search
- **Settings**: toggle options, verify they persist after reload/relaunch
- **Hidden affordances**: before calling something missing, check context
  menus, long-press, swipe actions (`custom_actions` in the iOS a11y tree),
  overflow menus — see `docs/spec/AGENTS.md`
- **New features**: happy path + one edge case
- **Invisible behavior**: open the surface, then confirm via logs/disk that
  the call actually fired

## Step 4: Report

Summarize in a table: commands run, pass/fail, key observed behavior.

```
| Check            | Result | Notes                              |
|------------------|--------|------------------------------------|
| TypeScript       | PASS   |                                    |
| Build            | PASS   |                                    |
| Unit tests       | PASS   | 42/42                              |
| Rust core        | PASS   | conformance green                  |
| iOS build        | PASS   | build-ios-native clean             |
| Android tests    | SKIP   | no Android changes                 |
| UI (desktop)     | PASS   | 3 screenshots in test-screenshots/ |
| UI (iOS sim)     | PASS   | flush-and-read verified content    |
```

If anything failed, show the relevant error output and suggest a fix. List
screenshots/recordings taken with a one-line description of what each shows.
Distinguish **Blocked** (environment can't exercise it — say why) from
**FAIL** (observed wrong behavior).
