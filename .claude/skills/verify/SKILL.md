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
| Web dev server | pure CSS / markdown / editor decorations, no Tauri APIs | `references/desktop.md` |
| Tauri desktop | default for desktop features; anything touching Rust/`invoke()`/platform APIs | `references/desktop.md` |
| iOS simulator (native SwiftUI) | `apps/ios` changes, iOS-specific behavior, "on the simulator" | `references/ios.md` |
| Android emulator (native Compose) | `apps/android` changes, Android-specific behavior (IME, status bar) | `references/android.md` |
| Windows qemu VM (WebView2) | `#[cfg(windows)]`, native DnD, NSIS installer, clean-machine launch | `references/windows-vm.md` |

**Mobile is native, not Tauri**: the shipping mobile apps are the SwiftUI and
Compose shells on the shared Rust core. Neither has the MCP bridge — the
bridge is desktop-only. iOS is driven with `simctl` + `axe`, Android with
`adb` + CDP.

**Platform matrix** (`uname -s`): macOS = iOS + Android + desktop; Linux =
Android + desktop + the Windows qemu VM (no iOS). The playbooks note the few
OS-specific bits (Wayland env vars, SDK paths).

## Session setup, evidence, and teardown

Read `references/session.md` before app QA. It owns worktree/device isolation,
provisioning, story verdicts, evidence reuse, sync smoke, and cleanup. Read only the
platform playbook needed for the target. Defect capture lives in `references/evidence.md`.

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
| `packages/editor/src/{filename,tags,preview,images}.ts` | shared — the conformance-locked TS↔Rust note rules |
| `packages/editor/**` | editor — feeds desktop AND the native shells' embedded editor.html; toolbar manifest changes also regenerate native toolbar specs |
| `crates/**` | rust-core — consumed by the Tauri app and (via `futo-notes-ffi`) both native shells |
| `apps/tauri/src-tauri/**` | tauri-rust |
| `apps/ios/**` | ios-native |
| `apps/android/**` | android-native |
| `tests/**` | playwright-tests |
| `docs/spec/**` | spec |
| `.gitlab-ci.yml` | ci |

## Step 2: Run verification chains

Use the nearest `AGENTS.md` and root §7 to select the owning layer's complete chain;
`justfile` owns the commands. For shared code before merge, run `just check`;
use `just prepush` for broad or risky changes. Report any unavailable platform leg.

For documentation/tooling-only edits, run `just check-agent-docs` and
`just check-qa-input-safety`, plus tests for any changed executable tooling.
Spec edits also require the workflow in `docs/spec/AGENTS.md`. CI changes need a
real pipeline on the changed head with the affected jobs actually executed.

Do not pipe checks through `head` or `tail` without `pipefail`; use the recipes so
failed builds cannot look green. Read each check's result before continuing.

### shared — note-rule conformance

Both consumers and the differential lock are required:

```bash
pnpm run test:editor:minimal
just test-rust
```

`packages/editor/AGENTS.md` owns canonical Rust, the hot-path TS mirror, and reviewed
fixture updates; `tests/conformance/README.md` explains the differential.

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

Any match → Tauri. No match and purely CSS/markdown/editor decorations →
web is acceptable. Unsure → Tauri.

### Editor changes ship to three apps

The embedded editor (`editor.html`, built from the shared editor code) runs
on desktop AND inside both native shells. For editor-visible changes, verify
on desktop first (fast), then spot-check one native shell — `just ios-native`
/ `just android-native` rebuild the editor bundle automatically.

### Handling loading/async states in screenshots

A screenshot of a spinner is not verification. If a loading state is visible:
wait for the ready condition with a bounded timeout, then capture the final render.
If it never becomes ready, report as **STUCK** and
investigate via the platform's log channel. Every verified feature needs at
least one screenshot of the actual rendered UI.

### Features that require app restart

Crash-dialog-on-relaunch, preference recovery, scan-on-launch behaviors only
manifest after a restart: trigger the precondition → kill/terminate the app
(platform playbook has the command) → relaunch → verify. Don't skip these;
they break most often.

### Features that need a sync server

Follow `references/session.md` for the isolated server and cross-client smoke.
For client sync-stack changes, prefer `just test-cross-platform`, which starts its
own clients and server. A cold offline package cache can block server provisioning;
report that explicitly. The desktop driver API is in `references/desktop.md`.

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
