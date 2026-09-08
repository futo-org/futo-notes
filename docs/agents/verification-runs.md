# Worktree setup and repeatable verification

Start a task from a fetched main in its own worktree. Keep using the same checkout
for edits, builds and verification. `just orient` reports its identity and possible
slot collisions; it does not claim a device or verify a running app.

## Setup, including a plain SSH shell

From the new worktree:

```bash
bash scripts/dev-env.sh --install just setup portable
bash scripts/dev-env.sh just setup desktop --check
bash scripts/dev-env.sh just verify-run test-desktop-journeys
```

`dev-env.sh` activates the exact `.nvmrc` version for the command and its children.
It finds conventional nvm, fnm, Cargo, local-bin and Homebrew installations without
sourcing an interactive profile. With `--install`, it installs missing Node through
fnm; if fnm is absent, it uses Homebrew on macOS or the existing checksummed Linux
installer. It does not edit shell profiles or change the global Node default.
Activation lasts for that invocation: wrap **every** command from a sparse SSH shell.

`just setup [portable|desktop|ios|android]` checks tools, then runs
`pnpm install --frozen-lockfile` and creates the empty `dist/` needed by Rust builds.
It requires Git, just, Rust and the packageManager-pinned pnpm to be installed.
It reports missing platform prerequisites before dependency installation or a Rust
build: Linux desktop libraries/display, Xcode/xcodegen/iOS runtime, or Android
SDK/pinned NDK/cargo-ndk/JDK 17 or 21. Set `ANDROID_HOME`, `ANDROID_NDK_HOME` and
`JAVA_HOME` as directed by the Android manual. Setup does not provision SDKs, claim
devices, launch apps or prove device readiness. Existing `pnpm prepare` hooks still run.

For a check that cannot install Node or dependencies, use:

```bash
bash scripts/dev-env.sh node scripts/setup-worktree.mjs ios --check
```

`just setup --check` skips dependency installation but retains setup's permission
to provision Node. Native build/test recipes run the noninstalling prerequisite
check before rebuilding Rust bindings. Wrap the outer `just` with `dev-env.sh` so
the pinned environment also reaches subsequent build steps.

The same commands work in a manually created or app-created checkout. On the Mac,
run them over SSH from a dedicated Mac worktree containing the intended source;
keep debug bridges on loopback and run drivers on that host. Use `just qa-claim ios`
and pass its `SIM` to `just verify-run test-ios-stories` for native keyboard QA.
Claims and the native app's required rebuild remain mandatory. Setup itself does
not prove that an iOS journey passed.

## Evidence that survives reruns

```bash
just verify-run check
just verify-run test-e2e
just verify-run test-desktop-journeys
just verify-run test-cross-platform --no-android
```

Every invocation creates a unique, gitignored `verification-runs/<time>-<id>/`:

- `manifest.json`: command argv, host, platform, timestamps, exit status, Git HEAD
  and fingerprints of tracked/untracked nonignored source before and after the run.
- `command.log`: combined stdout/stderr, also streamed to the terminal.
- `report.md`: verdict and links to captured artifacts.
- Harness artifacts: Playwright JSON/HTML plus failure traces/video/screenshots;
  desktop target verification, executable hash, app logs, synthetic vault and
  journey state; sync result JSON, per-server logs and isolated test databases.

The runner exports `FUTO_VERIFICATION_DIR` to recipes. A harness should write its
artifacts there when set and keep its existing default paths otherwise. It does
not automatically collect arbitrary files from a harness that ignores this variable.
Native recipes currently preserve command output; use their owning playbooks to
collect device screenshots and native result bundles separately.

PASS means the recipe exited zero. FAIL preserves its nonzero exit status. VOID
(exit 76) means source identity changed during the run, even if the recipe passed.
An interrupted runner may leave RUNNING; that is incomplete evidence. Fingerprints
exclude ignored/generated files and `keys/`, and compare endpoints rather than
monitoring every intermediate write. Build provenance therefore belongs to the
harness: the new desktop journeys rebuild web and Rust sources and record the
executable hash. A generic `check` PASS does not establish any device/engine claim.

A red run followed by a green run keeps both bundles. Ordinary Playwright runs
cannot wipe these bundles because they sit outside `test-results/`. Evidence is
local, retained without automatic cleanup, and may contain synthetic note bodies
and debug logs. Inspect a bundle before sharing it; do not commit generated output.

## Complete desktop journeys

`just test-desktop-journeys` builds an embedded debug app with test hooks, creates
its own synthetic vault and verifies each process with `qa-target` before sending
bridge input. Restarts reuse only that run's storage. It checks:

1. Create and save a note, terminate/relaunch, reopen, edit, save and relaunch again.
2. Create a referencing note, rename its target through the title field, relaunch,
   and verify the repaired backlink and absence of the old file.

Assertions compare editor state, app reads and persisted bytes. The report records
the exact input mechanism: WebView text insertion, the existing editor replacement
hook and title input events. This covers save/lifecycle/backlink behavior on
WebKitGTK or WKWebView; it does not establish physical keyboard, IME, visual painting
or Windows WebView2 behavior. State snapshots are not screenshots.

Use the existing cross-platform sync harness for offline accumulation, concurrent
edits and peer deletion. Its arguments are exposed by `just test-cross-platform`,
for example `just verify-run test-cross-platform --no-android --scenario offline`.
It uses its existing per-server ownership checks and synthetic databases. The
separate persistent `qa-server` ownership papercut `pc_980ab7becd04` remains open;
this work does not change that server or resolve finite-slot collisions.

For handoff, provide the worktree/branch, report path, tested fingerprint and
command, platform/engine and input mechanism, failures/skips, and any resources
still owned. Keep the nearest layer's complete verification chain authoritative.
