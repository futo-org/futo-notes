default:
  @just --list --unsorted

alias i := install
alias td := tauri-dev
alias tp := tauri-prod
alias tb := tauri-build
alias an := android-native
alias in := ios-native
alias b := build
alias t := test
alias tu := test-unit
alias te := test-editor
alias l := lint
alias c := check
alias pp := prepush
alias dd := deploy-deb
alias dr := deploy-rpm
alias di := deploy-ios

install:
  pnpm install

preview:
  pnpm run preview

lint:
  pnpm run lint

format:
  pnpm run format

format-check:
  pnpm run format:check

# The repo rule is that every command goes through `just`, but only the
# TypeScript side had formatting recipes — so Rust changes had no sanctioned way
# to be formatted or checked. rustfmt is pinned by rust-toolchain.toml (1.89.0),
# so both are reproducible across machines and CI.
# Format the Rust workspace.
rust-format:
  cargo fmt --all

# Fail if any Rust file is unformatted.
rust-format-check:
  cargo fmt --all --check

# Lint the hand-written Swift production and test sources (read-only) with swift-format, which
# ships with Xcode 16+ (`xcrun swift-format`). The generated UniFFI bindings
# (Sources/Generated) are excluded — they are not ours to style.
lint-swift:
  find apps/ios/Sources apps/ios/Tests apps/ios/UITests \
    -name '*.swift' \
    -not -path '*/Generated/*' \
    -not -path '*/GeneratedContracts/*' \
    -print0 \
    | xargs -0 xcrun swift-format lint --strict --configuration apps/ios/.swift-format

# ── Desktop (Tauri) ──

# Desktop dev. `--fake-update[=X.Y.Z]` shows a simulated update (banner/Settings
# iteration without a server or signed build); install is simulated.
tauri-dev *args:
  node scripts/tauri-dev.mjs {{args}}

tauri-prod:
  pnpm run build
  cd apps/tauri && WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev --config src-tauri/tauri.prod.conf.json

tauri-build:
  pnpm run build
  # NO_STRIP=true: linuxdeploy ships an old `strip` that can't read
  # .relr.dyn sections emitted by newer binutils (Fedora 39+, Arch, etc.),
  # which breaks AppImage bundling. CI runs on ubuntu:22.04 where stock
  # strip matches, so this is local-only noise.
  cd apps/tauri && NO_STRIP=true cargo tauri build

# ── In-app updater: local verified-build dry-run ──
# Mirrors the prod release flow EXACTLY (same scripts/release-build.mjs), with
# stand-in keys: only host (localhost), signing key (committed keys/localdev),
# and baked pubkey (localdev) differ. Builds OLD + NEW signed AppImages, serves
# the update on :8787, prints the command to run the OLD app. See keys/README.md
# + scripts/release-build.mjs. Linux/AppImage only; Ctrl-C to stop.
updater-localdev *args:
  node scripts/release-build.mjs e2e {{args}}

# ── Instance journal (desktop) ──
# Read what a running instance actually DID: the app writes a JSONL event
# journal (futo_notes_core::journal) under its app data dir — never inside a
# vault, never uploaded anywhere. Today it records an `app_launch` marker per
# run of the app — the anchor every later event is read against — and one
# `sync_run` event per sync cycle: trigger (manual/live-catch-up/local-change/
# remote-change/safety-poll), push and pull timings, counts, the version
# watermarks either side of the run, and the per-file reconcile decisions with
# the reason the summary counters throw away.
#
#   just journal                    # last 20 events
#   just journal tail 100
#   just journal type sync_run      # or app_launch, journal_drops
#   just journal last-sync          # readable summary of the newest cycle
#   just journal startup            # per launch, how long until it first synced
#   just journal where              # which directory it is reading
#   just journal ... --release      # the release app, not the dev build
#   just journal ... --dir <path>   # somewhere else entirely (a pulled phone journal)
#
# Resolution matches the app: $FUTO_NOTES_DATA_DIR wins (that is what
# `just tauri-dev` sets, per worktree), then <app data>/<bundle id>/journal.
# `--json` prints raw lines, so `just journal type sync_run --json | jq` works.
# Native shells do not journal yet (see docs/spec/sync.md).
journal *args:
  @node scripts/journal.mjs {{args}}

# ── Native mobile shells (SwiftUI / Compose — the SHIPPING mobile apps) ──
# These reuse the shared Rust core (futo-notes-ffi) + the embedded web editor.
# There is no longer a Tauri mobile shell; mobile = native.

# Build futo-notes-ffi for all Android ABIs + generate Kotlin bindings.
# Requires ANDROID_NDK_HOME + `cargo install cargo-ndk`.
build-rust-android:
  bash scripts/build-rust-android.sh

# Build the SAME Rust ffi xcframework for the native iOS app.
build-rust-ios:
  bash scripts/build-rust-ios.sh

# Build + run the native Android Compose app (Rust core + WebView editor).
# Requires Android SDK + NDK + cargo-ndk + a device/emulator.
android-native:
  apps/android/run.sh

# Build + run the native iOS app on the booted SIMULATOR (no signing).
ios-native:
  apps/ios/run.sh

# Build + run the native iOS app on a CONNECTED PHYSICAL iPhone (Debug, signed).
# Reuses the Tauri app's dev team; override with FUTO_DEV_TEAM=<team id>.
ios-native-device:
  apps/ios/run-device.sh

# Compile-only sanity for the native iOS app (no install); `just ios-native` runs it.
build-ios-native: build-rust-ios
  #!/usr/bin/env bash
  set -euo pipefail
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/ios
  xcodegen generate
  # The generic simulator destination links both arm64 and x86_64;
  # build-rust-ios.sh lipos a universal simulator slice so both resolve.
  xcodebuild -project FutoNotesNative.xcodeproj \
    -scheme FutoNotesNative -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath .build \
    CODE_SIGNING_ALLOWED=NO build | tail -3

# Compile-only sanity for the native Android app (assembleDebug, no install).
build-android-native: build-rust-android
  #!/usr/bin/env bash
  set -euo pipefail
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/android
  ./gradlew :app:assembleDebug

# ── Native unit tests ──

# Swift Testing for the native iOS app (the FutoNotesNativeTests target). Runs
# on a CONCRETE simulator — `xcodebuild test` cannot run against a generic
# destination. Honors $SIM (from `just qa-claim ios`); otherwise the single
# booted simulator. Fails red on any test failure.
test-ios-native: build-rust-ios
  #!/usr/bin/env bash
  set -euo pipefail
  node_modules/.bin/vite build --config vite.editor.config.ts
  SIM="${SIM:-$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)).*Booted.*/\1/p' | head -1)}"
  if [ -z "$SIM" ]; then
    echo "No simulator — set SIM=<udid> or run: just qa-claim ios" >&2
    exit 1
  fi
  echo "==> Simulator: $SIM"
  cd apps/ios
  xcodegen generate
  # A concrete -destination "id=$SIM" resolves to ONE arm64 simulator, so the
  # arm64-only FFI sim slice links without EXCLUDED_ARCHS (contrast the generic
  # destination in build-ios-native). Ad-hoc sign so the app test host launches
  # with its keychain entitlement (mirrors run.sh).
  xcodebuild test -project FutoNotesNative.xcodeproj \
    -scheme FutoNotesNative \
    -destination "id=$SIM" \
    -derivedDataPath .build \
    CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="-"

# JVM unit tests for the native Android app (e.g. SyncManagerDefaultsTest).
# Depends on build-rust-android so the UniFFI Kotlin bindings (gitignored)
# exist — compiling the app module needs them.
test-android-native: build-rust-android
  cd apps/android && ./gradlew testDebugUnitTest

# Runs Compose instrumentation tests on $ANDROID_SERIAL.
test-android-native-ui: build-rust-android
  cd apps/android && ./gradlew connectedDebugAndroidTest

# User-level storage-location stories against the REAL native Android app: the
# first-run picker, both migration directions, and opening an already-populated
# folder — each asserted on the vault that actually lands on disk. ~35s, of which
# ~30s is the two stories that deliberately tap real UI; the rest drive the debug
# build's hooks via tests/lib/android/. Needs a device/emulator with the debug app
# installed (`just android-native`); honors $ANDROID_SERIAL. It CLEARS the debug
# app's data, so claim a pool device first (`just qa-claim android`) rather than
# pointing it at a phone you care about. Deliberately not in `check`/CI — runners
# have no emulator.
test-android-storage:
  node tests/android-storage-migration.mjs

# Sustained human-cadence typing against the REAL native iOS app, with the
# simulator vault as the oracle: exactly the seeded note, byte-exact content,
# and no conflict copies or other unrequested files. The build/install is
# deliberately mandatory so the story always exercises the code being pushed.
# Requires SIM from `just qa-claim ios`; the runner verifies pool ownership.
test-ios-stories:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -n "${SIM:-}" ] || { echo 'No claimed simulator — run: eval "$(just qa-claim ios)"' >&2; exit 1; }
  SIM="$SIM" just ios-native
  SIM="$SIM" node tests/ios-editor-stories.mjs

# ── Parallel QA isolation (multiple worktrees, one machine) ──
# Worktree path → slot → pooled devices (futo-qa-0..6 per platform) + a
# per-slot sync server with its own Postgres database. Your personal
# simulators/AVDs are never touched. See scripts/qa.mjs and the /verify
# skill's "Isolation model" section.

# Prints `export SIM=…` / `export ANDROID_SERIAL=…` — eval or copy them.
# Pass `--reboot` when `axe`/`idb` report a 0x0 root for a booted simulator:
# that means it has no Simulator.app window in this WindowServer session, and a
# full shutdown/boot cycle is the only fix (simctl screenshot keeps working the
# whole time, which is why it looks like an app bug).
# Claim (create + boot if needed) this worktree's pooled simulator/emulator.
qa-claim target="all" *flags:
  @node scripts/qa.mjs claim {{target}} {{flags}}

# Show pool devices + per-slot sync servers, and which worktree owns each.
qa-status:
  @node scripts/qa.mjs status

# Slot-derived, so parallel checkouts never collide. $FUTO_DEV_PORT pins `web`.
# Print every port this worktree owns.
ports:
  @node scripts/lib/slot.mjs

# Release this worktree's devices (add --shutdown to also power them off).
# Also stops this worktree's qa-server so nothing is left orphaned.
qa-release *flags:
  @node scripts/qa.mjs release {{flags}}

# Reap pool devices/servers owned by worktrees that no longer exist.
qa-gc:
  @node scripts/qa.mjs gc

# APFS-clone (copy-on-write) this checkout's target/ into a worktree: a 31GB
# target/ clones in seconds and shares blocks until builds diverge, killing
# the cold-build tax on parallel QA worktrees. Run from a built checkout.
# Seed a QA worktree with a warm cargo build (APFS clone of target/).
qa-clone-target dest:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -d target ] || { echo "no target/ in $(pwd) — build here once first" >&2; exit 1; }
  [ -d '{{dest}}' ] || { echo "worktree '{{dest}}' does not exist" >&2; exit 1; }
  [ -e '{{dest}}/target' ] && { echo "'{{dest}}/target' already exists — remove it first" >&2; exit 1; }
  cp -Rc target '{{dest}}/target'
  echo "Cloned target/ → {{dest}}/target (APFS copy-on-write)"

# Start this worktree's isolated sync server (own port + own Postgres DB).
qa-server:
  @node scripts/qa.mjs server-start

# Stop it (add --drop to also drop its database and blobs).
qa-server-stop *flags:
  @node scripts/qa.mjs server-stop {{flags}}

# ── Simulator / emulator QA helpers ──
# Mechanics for driving the native apps under QA. The judgment layer (how to
# read a11y trees, what can't be automated, failure modes) lives in the
# /verify skill's references/ios.md and references/android.md. All sim-*
# helpers honor $SIM (from qa-claim); adb-based ones honor $ANDROID_SERIAL.

# Deliberately does NOT foreground Simulator.app: `simctl` boots, installs,
# launches and screenshots a headless device just fine, while activating the app
# drags whoever is typing to another space (parallel QA sessions on one Mac).
# Pass SHOW=1 when a HUMAN needs to watch, or when measuring anything that
# awaits a frame — an occluded window has its rendering suspended.
# Boot an iOS simulator by name (no-op if already booted) and wait for it.
sim-boot name="iPhone 17 Pro":
  #!/usr/bin/env bash
  set -euo pipefail
  xcrun simctl boot '{{name}}' 2>/dev/null || true  # "already booted" is fine
  if [ -n "${SHOW:-}" ]; then open -a Simulator; fi
  for i in $(seq 1 30); do
    xcrun simctl list devices booted | grep -q Booted && break; sleep 1
  done
  just sim-udid

# Print the target simulator UDID: $SIM when set, else the single booted one.
sim-udid:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ -n "${SIM:-}" ]; then echo "$SIM"; exit 0; fi
  UDIDS=$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)).*Booted.*/\1/p')
  COUNT=$(printf '%s' "$UDIDS" | grep -c . || true)
  [ "$COUNT" -ge 1 ] || { echo "No booted simulator. Boot one: just sim-boot (or just qa-claim ios)" >&2; exit 1; }
  [ "$COUNT" -eq 1 ] || { echo "Multiple booted simulators — set SIM=<udid> (just qa-claim ios prints it):" >&2; echo "$UDIDS" >&2; exit 1; }
  echo "$UDIDS"

# Screenshot the target simulator ($SIM, else booted) → test-screenshots/<name>.png
sim-screenshot name="sim":
  @mkdir -p test-screenshots
  xcrun simctl io "${SIM:-booted}" screenshot 'test-screenshots/{{name}}.png'

# Flip the target simulator's system appearance (dark|light).
sim-appearance mode="dark":
  xcrun simctl ui "${SIM:-booted}" appearance {{mode}}

# NOTE: the app logs mostly via print(), which os_log does NOT capture — for
# stdout, relaunch with `xcrun simctl launch --console-pty booted com.futo.notes.dev`.
# Stream the native iOS app's os_log/WebKit output (see NOTE above for print()).
sim-logs:
  xcrun simctl spawn "${SIM:-booted}" log stream --level=debug --predicate 'process == "FutoNotesNative"'

# Print the debug app's (com.futo.notes.dev) notes root in the sim container.
sim-container:
  @echo "$(xcrun simctl get_app_container "${SIM:-booted}" com.futo.notes.dev data)/Documents/fake-notes"

# Boot the first available AVD if none is connected; wait up to 120s for it.
emu-boot:
  #!/usr/bin/env bash
  set -euo pipefail
  if adb devices | grep -qE '\tdevice$'; then
    echo "Android device/emulator already connected:"; adb devices | grep -v '^List'; exit 0
  fi
  EMULATOR="${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator/emulator"
  AVD=$("$EMULATOR" -list-avds 2>/dev/null | head -1)
  [ -n "$AVD" ] || { echo "No AVDs available — create one with Android Studio or avdmanager." >&2; exit 1; }
  echo "Launching AVD: $AVD"
  "$EMULATOR" -avd "$AVD" -no-snapshot-load >/dev/null 2>&1 &
  # Wait for the package service too, not just boot_completed: the property
  # flips first, and an `adb install` issued in that window fails with
  # "cmd: Can't find service: package".
  for i in $(seq 1 60); do
    if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] \
      && adb shell service check package 2>/dev/null | grep -q found; then
      echo "Booted."; exit 0
    fi
    sleep 2
  done
  echo "Emulator did not boot within 120s" >&2; exit 1

# With several devices attached, set ANDROID_SERIAL first.
# Screenshot the connected Android device/emulator → test-screenshots/<name>.png
emu-screenshot name="emu":
  @mkdir -p test-screenshots
  adb exec-out screencap -p > 'test-screenshots/{{name}}.png'

# `adb logcat -c` first for a clean slate; crashes land under AndroidRuntime.
# Tag-scoped logcat for the native Android app's stable log tags.
emu-logs:
  adb logcat -s FutoStartup FutoSearch NotesStore FutoTestHook FutoToolbarDBG FutoBridgeDBG AndroidRuntime

# Debug builds only; re-run after every app restart (the WebView pid changes).
# adb forward host ports are machine-global, so the port is per-worktree
# (9330 + slot; override with $CDP_PORT). cdp-invoke.mjs honors $CDP_PORT.
# Forward the Android app's WebView DevTools socket for cdp-invoke.mjs.
cdp-forward:
  #!/usr/bin/env bash
  set -euo pipefail
  PORT="${CDP_PORT:-$(node scripts/lib/slot.mjs cdp)}"
  PID=$(adb shell pidof com.futo.notes.dev | tr -d '\r')
  [ -n "$PID" ] || { echo "com.futo.notes.dev is not running — launch the app first." >&2; exit 1; }
  SOCKET=$(adb shell 'cat /proc/net/unix' | grep -o "webview_devtools_remote_${PID}" | head -1)
  [ -n "$SOCKET" ] || { echo "No DevTools socket for pid $PID — has the editor WebView been opened yet?" >&2; exit 1; }
  adb forward "tcp:${PORT}" "localabstract:${SOCKET}"
  echo "Forwarded localhost:${PORT} → ${SOCKET}"
  echo "  export CDP_PORT=${PORT}   # then: node scripts/cdp-invoke.mjs \"document.title\""

# Drive the native Android app: read its state, tap labels, run debug hooks.
# `state` answers from the app itself (~100ms) instead of an accessibility dump
# (~2s), and reports what the a11y tree can't — which vault is live, whether a
# migration is in flight. Run with no arguments for the command list. Debug
# builds only; honors $ANDROID_SERIAL.
android-drive *args:
  @node scripts/android-drive.mjs {{args}}

build:
  #!/usr/bin/env bash
  # `just` runs each unshebanged line via a fresh `sh -c` with pipefail off, so
  # `cmd | head -N` reports head's exit status (always 0), not cmd's — a
  # failing tsc/vite build would go green. pipefail here makes the pipeline
  # fail when the left side does.
  set -euo pipefail
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

test:
  pnpm run test:minimal

test-full:
  pnpm run test:full

# Run ONE test file (or a name pattern), installing deps first if this is a
# fresh worktree. `pnpm exec vitest ...` from a worktree with no node_modules
# fails with ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL / 'Command "vitest" not found',
# which says nothing about the real cause (pc_cd6fa6e7aa76).
#   just test-one src/features/notes/notes.test.ts
#   just test-one -t 'renames a note'
# Run ONE test file or -t pattern (installs deps if the worktree is fresh).
test-one *args:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -d node_modules ] || { echo "==> node_modules missing — pnpm install"; pnpm install; }
  node_modules/.bin/vitest run {{args}}

test-unit:
  pnpm run test:unit

test-unit-full:
  pnpm run test:unit:full

test-editor:
  pnpm run test:editor

test-editor-full:
  pnpm run test:editor:full

test-e2e:
  pnpm run test:e2e:smoke

test-e2e-full:
  pnpm run test:e2e:full

# EXACTLY what CI's test:e2e:rest job runs — everything except the P0 crash/IME
# spec, two workers. Named as a recipe so it can be reproduced verbatim locally
# and remotely (`just remote test-e2e-rest`), which is how the mr-203
# remote-rename failure was pinned to a stale stack base rather than a flake.
test-e2e-rest:
  pnpm run test:e2e:rest

test-cross-platform:
  pnpm run test:cross-platform

test-markdown-spec:
  pnpm run test:markdown-spec

test-headed:
  pnpm run test:headed

test-ui:
  pnpm run test:ui

test-desktop-smoke:
  node tests/desktop-smoke.mjs

test-rust:
  cargo test -p futo-notes-model --test conformance
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

test-rust-full:
  mkdir -p dist
  cargo test --workspace
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# ── Remote (Linux) test execution ──
# Everything that does NOT need macOS/Xcode/WKWebView runs on a Linux box over
# Tailscale (default: jfedora, 32 cores / 125 GB / KVM), so the Mac stays free
# for the iOS and desktop work only it can do. scripts/remote-test.mjs REFUSES
# macOS-only recipes by name (including via their justfile aliases) rather than
# trusting a doc to be read, propagates the remote exit status verbatim (M11),
# and prints the transfer mode + sha every run so a stale remote checkout can't
# pass for your local work. Flags go BEFORE the recipe; `--rsync` sends the
# dirty working tree instead of a pushed sha, `--wait` queues behind a run in
# progress. Runs are serialised by a lock on the remote worktree and the sha is
# re-checked afterwards: exit 75 = BLOCKED, 76 = the checkout moved mid-run so
# the result is VOID. The remote worktree is the RUNNER'S OWN working area —
# never cd into it and run suites by hand, that bypasses the lock and
# manufactures failures that look exactly like real ones. What a Linux run can
# and cannot prove (the WebKitGTK/WKWebView boundary), plus why setup dominates
# the short suites (~25s setup around ~3s of tests): docs/remote-testing.md.

# Prints the exact commands a human with sudo must run; start here when adding
# a second Linux box.
# Report what is present/missing on the remote (node, cargo, NDK, KVM, Postgres…).
remote-doctor *flags:
  node scripts/remote-test.mjs --doctor {{flags}}

# Run any portable recipe remotely: `just remote test-full`, `just remote --rsync test-unit`.
remote *args:
  node scripts/remote-test.mjs {{args}}

# Equivalent to a Mac `just check` — tsc, eslint, prettier, svelte-check,
# vitest (jsdom), vite build, arch gates, Rust conformance — none of which
# touch a real web engine, so this carries no WebKit caveat.
# The pre-merge umbrella, remotely.
remote-check *flags:
  node scripts/remote-test.mjs {{flags}} check

# The box's 32 cores also make futo-notes-search's CI-only "keyword index never
# became ready" contention flake vanish.
# The full Rust workspace, remotely.
remote-rust *flags:
  node scripts/remote-test.mjs {{flags}} test-rust-full

# Sync state and files are engine-independent; rendering is not (see the doc).
# Ports and the Postgres database are slot-derived, so different worktrees don't
# collide; two runs in the SAME remote worktree share a slot, which the worktree
# lock prevents (and the harness now refuses loudly instead of adopting).
# Cross-platform E2EE sync against the box's own Postgres + server checkout.
remote-sync *flags:
  node scripts/remote-test.mjs {{flags}} test-cross-platform

# Device/instrumentation legs still need an emulator booted ON the box; KVM
# there makes those far faster than the Mac's emulation once wired up.
# Android Rust .so + Kotlin bindings + assembleDebug, then the JVM unit tests.
remote-android *flags:
  node scripts/remote-test.mjs {{flags}} build-android-native
  node scripts/remote-test.mjs {{flags}} test-android-native

# Factory: compare our editor to Obsidian's, scenario by scenario.
# See factory/AGENTS.md.
factory-judge *args:
  pnpm exec tsx factory/judge/run.ts --no-moves {{args}}

factory-judge-headed *args:
  pnpm exec tsx factory/judge/run.ts --no-moves --headed {{args}}

# Boot a long-running judge: Obsidian + chromium stay up, listening on
# factory/captures/daemon.sock. Use `factory-run`, `factory-watch`, and
# `factory-down` to drive it. Foreground process — Ctrl-C tears down.
factory-up *args:
  pnpm exec tsx factory/judge/run.ts daemon {{args}}

# Send a one-shot run to the daemon and stream divergences as they
# happen. Defaults to --no-moves like factory-judge.
factory-run *args:
  pnpm exec tsx factory/judge/run.ts run --no-moves {{args}}

# Re-run on every save of editor source files. Talks to the running
# daemon and reloads the futo-notes page before each run so HMR drift
# can't lie to you.
factory-watch *args:
  pnpm exec tsx factory/judge/run.ts watch --no-moves {{args}}

factory-down:
  pnpm exec tsx factory/judge/run.ts down

# Phase-1 visual oracle: inject a neutral theme into both editors,
# screenshot every scenario in the curated visual set, run a pixel
# diff, and emit factory/captures/visual-report.html. Pair with
# `just factory-up` (daemon must be running). After the run, ask
# Claude Code to "review the visual report" for an LLM-judge pass.
factory-visual *args:
  pnpm exec tsx factory/judge/run.ts run --no-moves --visual-only {{args}}

factory-summary:
  @node -e "const r = require('./factory/captures/last-run.json'); \
    console.log(JSON.stringify(r.summary, null, 2)); \
    const fail = r.reports.filter(x => x.divergences.length).sort((a,b) => b.divergences.length - a.divergences.length); \
    console.log('\\nWorst scenarios:'); \
    for (const x of fail.slice(0, 15)) console.log(' ', String(x.divergences.length).padStart(3), x.name);"

# Regenerate docs/spec/GAPS.md from the inline `> **Gap:**` notes in
# docs/spec/*.md (which remain the source of truth).
spec-gaps:
  node scripts/spec-gaps.mjs --write

# Fail if GAPS.md is stale, or if a closure probe finds codebase evidence
# that a recorded gap has been implemented (= the spec needs updating).
spec-gaps-check:
  node scripts/spec-gaps.mjs --check

# Regenerate the native shells' toolbar specs
# (apps/ios/Sources/Editor/GeneratedContracts/ToolbarSpec.swift)
# from the @futo-notes/editor toolbar manifest (packages/editor/src/toolbar.ts —
# the single source of truth for the mobile toolbar surface).
toolbar-spec:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --write

# Fail if a generated native toolbar spec has drifted from the manifest.
toolbar-spec-check:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --check

# Regenerate the native shells' title-validation constants
# (apps/ios/Sources/Editor/GeneratedContracts/TitleSpec.swift /
# apps/android/.../TitleSpec.kt) from the
# @futo-notes/editor title-rule manifest (packages/editor/src/filename.ts).
title-spec:
  pnpm exec tsx scripts/gen-title-spec.ts --write

# Fail if a generated native title spec has drifted from the manifest.
title-spec-check:
  pnpm exec tsx scripts/gen-title-spec.ts --check

# Fail on a registered-but-uncalled Tauri command not in the allowlist, a
# stale allowlist entry (command now has a caller, or was deleted from Rust),
# or an invoke() of a name that isn't registered at all (architecture-
# hardening.md F24 / L2-4 gate 1).
check-command-reachability:
  node scripts/check-command-reachability.mjs

# Fail on an `invoke(`/`@tauri-apps` import outside src/lib/platform/** and
# the frozen allowlist, or a stale allowlist entry (F29 / L2-4 gate 2) —
# `lint:platform` only greps for removed Electron/Capacitor strings.
check-platform-discipline:
  node scripts/check-platform-discipline.mjs

# Regenerate the native bridge-coverage specs from the @futo-notes/editor
# futoBridge contract (packages/editor/src/bridge.ts).
bridge-spec:
  pnpm exec tsx scripts/gen-bridge-spec.ts --write

# Fail if the generated native bridge specs have drifted from bridge.ts.
bridge-spec-check:
  pnpm exec tsx scripts/gen-bridge-spec.ts --check

# Generate TypeScript records from the Rust-owned Tauri sync IPC contract.
sync-contract:
  mkdir -p dist
  FUTO_UPDATE_SYNC_CONTRACT=1 cargo test -p futo-notes-tauri generated_typescript_contract_is_current

sync-contract-check:
  mkdir -p dist
  cargo test -p futo-notes-tauri generated_typescript_contract_is_current

# Fail on a stale drift-registry.json entry (copy missing / pattern no longer
# matches / lock file missing / lockStatus inconsistent), or a NEW file
# matching a registered concept's scan pattern outside its registered copies
# (architecture-hardening.md R1 — AGENTS.md "Drift watchlist" as code, deny-by-default).
check-drift:
  node scripts/drift-check.mjs

# No space switch and no stolen keyboard focus, so a parallel QA session cannot
# yank the human out of whatever they are typing in: it captures the window
# where it lives, even on another space (`screencapture -l <window id>`).
# Refuses anything scripts/qa-target.mjs will not verify as a debug build of
# THIS worktree, since a window can show the user's real vault (M24). With a
# live bridge, prefer its capture_native_screenshot; frame/paint probes still
# need a genuinely VISIBLE window, which no capture tool can substitute for.
#   just qa-shot list | pid <pid> | port <port> [--out <path>]
# Screenshot this worktree's desktop QA window WITHOUT activating it.
qa-shot *args:
  @node scripts/qa-shot.mjs {{args}}

# Fail if any instruction surface (README/AGENTS.md/docs/**/skills/agents, plus
# this justfile) teaches OS-level input into this app (AppleScript UI scripting,
# click injection), a process-name lookup or pattern KILL against it or its
# toolchain, or a relative `find -newermt` safety check.
# 2026-08-10: a QA agent drove the INSTALLED release app on the user's real vault
# that way. 2026-08-19: three parallel agents pattern-killed each other's dev
# stacks. Rationale + the allowlist contract: scripts/check-qa-input-safety.mjs.
check-qa-input-safety:
  node scripts/check-qa-input-safety.mjs

# Resolve a desktop QA target safely: the ONLY sanctioned way to turn a port or
# PID into something you may drive. Verifies the executable is a debug build
# inside THIS worktree (plus its data dir and vault) and exits 3 on anything
# else — emphatically an installed application bundle.
#   just qa-target list | pid <pid> | port <port> | kill
qa-target *args:
  @node scripts/qa-target.mjs {{args}}

# Fail on a broken `just <recipe>`/`pnpm run <script>`/repo-path reference inside
# an instruction surface (README/AGENTS.md/skill SKILL.md+references/workflows) —
# agents follow these files literally, so a stale command or path sends them down
# a dead end. See scripts/check-agent-docs.mjs for the escape hatch.
check-agent-docs:
  node scripts/check-agent-docs.mjs

# The meta-gate: prove every OTHER gate actually fails on the violation it
# claims to catch. Seeds one violation per gate inside a throwaway git worktree
# and requires the gate to exit non-zero AND name what it found — an
# exit-code-only pass is rejected, because a gate that dies on a missing module
# also exits non-zero. Six commits (d87173eb, 54d1cc41, 90a62902, a6c6e2d5,
# db31586c, f81a61d0) fixed guards that were green while stepping over real
# violations; this is the standing red-proof they lacked. `--include-cargo`
# adds the Rust dependency-boundary proof (the portable set runs in CI, whose
# image has no cargo). Rationale + limitations: scripts/gate-redproofs.mjs
# (documented there rather than in AGENTS.md, which is for rules agents must
# follow, not rationale for the tooling that checks them).
gate-redproofs *args:
  node scripts/gate-redproofs.mjs --include-cargo {{args}}

# Run the same focused architecture checks embedded in GitLab's mandatory test job.
# package.json owns the membership because the pinned CI image does not include just.
arch-gate:
  pnpm run check:arch-gate

# Link this checkout's third-party skills (mattpocock/skills — /tdd, /research,
# /wayfinder, …) from the gitignored .agents/skills/ into .claude/skills/, where
# Claude Code discovers them. skills-lock.json is the registry of which ones we
# use; an external installer populates .agents/skills/ per machine, and nothing
# in this repo fetches them — so this recipe links only what is already present
# and REPORTS the rest instead of leaving a dangling link behind. The links are
# gitignored on purpose: MR !207 committed 22 of them, and because .agents/ is
# gitignored they dangled in every fresh clone and every git worktree. Run it
# once per checkout; it is idempotent.
skills-link:
  @node scripts/skills-link.mjs

# ── Dependency vulnerability scan ──
# Needs network and cargo-audit on PATH (`cargo binstall cargo-audit --locked`). `--fix` drops
# ignore entries whose advisory is gone. CI runs this same script, non-blocking
# (docs/architecture-gates.md).
# Report known vulnerabilities across the project (Rust + npm).
audit *args:
  node scripts/audit.mjs {{args}}

# Remove native build artifacts (Xcode DerivedData + Gradle output + web dist)
# to reclaim disk. Leaves cargo `target/` alone (expensive to rebuild + shared).
clean:
  rm -rf dist
  rm -rf apps/ios/.build apps/ios/.build-device apps/ios/.build-device-release
  rm -rf apps/android/app/build apps/android/build

check: spec-gaps-check toolbar-spec-check title-spec-check arch-gate test-rust rust-format-check
  #!/usr/bin/env bash
  # See `build:`'s comment: pipefail is required so the `| head`/`| tail`
  # truncation on the last two lines can't mask a failing tsc/vite build.
  set -euo pipefail
  pnpm run lint
  pnpm run check:svelte
  pnpm run format:check
  pnpm run test:full
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

# Cross-platform sync needs the server repo at ~/Developer/futo-notes-server
# (+ Postgres); the full Playwright run needs installed browsers. Budget
# 30-60 min. What it still can't see: native-shell runtime behavior (device
# QA) and Windows/WebView2 (scripts/win-vm/).
# --retries=1: the local 30s test timeout (CI gets 90s) makes a ~250-test run
# flake on the odd slow navigation/click; one retry absorbs those while a
# genuinely broken test still fails both attempts (and is reported "flaky"
# when it passes only on retry — treat repeat offenders as real bugs).
# `check` runs the PORTABLE red-proof set through arch-gate; the explicit
# recipe here adds the cargo-dependent Rust dependency-boundary proof.
# Maximal pre-push gate: `check` + full Rust workspace + full E2E + cross-platform sync.
prepush: check test-rust-full gate-redproofs
  #!/usr/bin/env bash
  set -euo pipefail
  pnpm exec playwright test --retries=1
  pnpm run test:cross-platform
  bash scripts/run-ios-stories-if-available.sh
  echo "prepush green — check + rust workspace + full e2e + cross-platform sync + available iOS stories all passed"

ci:
  pnpm run ci

# Build .deb from current repo state and install it
deploy-deb:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  BUNDLE_DIR="target/release/bundle/deb"
  # Stamp version from latest git tag + commit distance
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
  COMMITS_SINCE=$(git rev-list "${LATEST_TAG}..HEAD" --count)
  BASE_VER="${LATEST_TAG#v}"
  if [ "$COMMITS_SINCE" -gt 0 ]; then
    VERSION="${BASE_VER}-dev.${COMMITS_SINCE}"
  else
    VERSION="${BASE_VER}"
  fi
  echo "Version: ${VERSION}"
  node -e "const fs=require('fs'),f='${CONF}',c=JSON.parse(fs.readFileSync(f));c.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
  # Clean stale bundles so we never install an old one
  rm -rf "$BUNDLE_DIR"
  echo "Building .deb package..."
  cd apps/tauri && cargo tauri build --bundles deb
  cd ../..
  DEB=$(ls -t "${BUNDLE_DIR}"/*.deb | head -1)
  # A single-checkout INSTALL step, and the only sanctioned pattern kill in this
  # repo: it stops EVERY FUTO Notes on the machine, which is what you want right
  # before overwriting /usr/bin, and is why both copies are pinned in
  # scripts/qa-input-safety-allowlist.json. Never copy this line for QA cleanup —
  # on a multi-worktree machine it takes out your peers' apps too (AGENTS.md M25);
  # use `just qa-target kill`. (`comm` is truncated to 15 chars, hence -f.)
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${DEB}..."
  sudo dpkg -i "$DEB"
  # Restore tauri.conf.json so git stays clean
  git checkout -- "$CONF"
  echo "Done. Installed FUTO Notes ${VERSION}."

# Build .rpm from current repo state and install it
deploy-rpm:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  BUNDLE_DIR="target/release/bundle/rpm"
  # Stamp version from latest git tag + commit distance
  LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
  COMMITS_SINCE=$(git rev-list "${LATEST_TAG}..HEAD" --count)
  BASE_VER="${LATEST_TAG#v}"
  if [ "$COMMITS_SINCE" -gt 0 ]; then
    VERSION="${BASE_VER}-dev.${COMMITS_SINCE}"
  else
    VERSION="${BASE_VER}"
  fi
  echo "Version: ${VERSION}"
  ROOT="$PWD"
  node -e "const fs=require('fs'),f='${CONF}',c=JSON.parse(fs.readFileSync(f));c.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
  # Restore tauri.conf.json however we exit — the install assertion below is
  # allowed to fail red, and a red exit must not leave the version stamp behind.
  # Anchored at $ROOT because the build step leaves us inside apps/tauri.
  trap 'git -C "$ROOT" checkout -- "$CONF"' EXIT
  # Clean stale bundles so we never install an old one
  rm -rf "$BUNDLE_DIR"
  echo "Building .rpm package..."
  cd apps/tauri && cargo tauri build --bundles rpm
  cd ../..
  RPM=$(ls -t "${BUNDLE_DIR}"/*.rpm | head -1)
  # A single-checkout INSTALL step, and the only sanctioned pattern kill in this
  # repo: it stops EVERY FUTO Notes on the machine, which is what you want right
  # before overwriting /usr/bin, and is why both copies are pinned in
  # scripts/qa-input-safety-allowlist.json. Never copy this line for QA cleanup —
  # on a multi-worktree machine it takes out your peers' apps too (AGENTS.md M25);
  # use `just qa-target kill`. (`comm` is truncated to 15 chars, hence -f.)
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${RPM}..."
  # Do NOT route this through dnf's version solver. `dnf reinstall` exits 0
  # while installing NOTHING when the installed version differs from the file
  # (it just prints "Nothing to do."), so the old `reinstall || install` chain
  # silently kept a stale binary on disk for 20 days — and `2>/dev/null` hid
  # the one message that explained why. `rpm -U --force` is unconditional:
  # it replaces the installed package whatever its version. First-time
  # installs still go through dnf so dependencies get resolved.
  if rpm -q futo-notes >/dev/null 2>&1; then
    sudo rpm -Uvh --force "$RPM"
  else
    sudo dnf install -y "$RPM"
  fi
  # Assert the install actually landed: compare the sha256 the package records
  # for the binary against what is now on disk. The package's own digest is the
  # reference, NOT target/release/futo-notes-tauri — the bundler strips the
  # binary, so the build output legitimately differs from the packaged copy.
  # This also catches the same-version no-op case, where the version string
  # alone would prove nothing.
  EXPECTED_SHA=$(rpm -qp --dump "$RPM" 2>/dev/null | awk '$1 == "/usr/bin/futo-notes-tauri" { print $4 }')
  ACTUAL_SHA=$(sha256sum /usr/bin/futo-notes-tauri 2>/dev/null | cut -d' ' -f1)
  if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
    echo "" >&2
    echo "INSTALL FAILED: /usr/bin/futo-notes-tauri is NOT the binary just built." >&2
    echo "  expected sha256 (in package): ${EXPECTED_SHA:-<no /usr/bin/futo-notes-tauri in package>}" >&2
    echo "  actual   sha256 (on disk):    ${ACTUAL_SHA:-<file missing>}" >&2
    rpm -q --qf '  rpm db has: %{NAME}-%{VERSION}-%{RELEASE}, installed %{INSTALLTIME:date}\n' futo-notes >&2 || true
    echo "  Nothing was installed — do not test against this binary." >&2
    exit 1
  fi
  echo "Done. Installed FUTO Notes ${VERSION} (verified on disk)."

# deploy-deb / deploy-rpm / deploy-ios all existed for prod installs while
# Android only had `android-native` (debug, com.futo.notes.dev) — so a request to
# install "the prod app" on all three platforms had to descope Android to a debug
# build. Release signing needs apps/android/keystore.properties (gitignored);
# without it Gradle produces an UNSIGNED release APK that cannot be installed, so
# this refuses up front and says what is missing rather than failing at adb.
# Honors $ANDROID_SERIAL.
# Build a RELEASE-signed Android build and install it (com.futo.notes).
deploy-android:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ ! -f apps/android/keystore.properties ]; then
    echo "No apps/android/keystore.properties — release builds cannot be signed." >&2
    echo "  A release APK without it is unsigned and will not install." >&2
    echo "  For a debug install on com.futo.notes.dev use: just android-native" >&2
    exit 1
  fi
  just build-rust-android
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/android && ./gradlew :app:assembleRelease
  APK=$(ls -t app/build/outputs/apk/release/*.apk | head -1)
  echo "Installing ${APK} (com.futo.notes)…"
  adb install -r "$APK"
  # Assert the PRODUCTION package is what landed — an unsigned or misconfigured
  # build could otherwise leave the .dev package installed and look successful.
  adb shell pm list packages | grep -qx 'package:com.futo.notes' || {
    echo "com.futo.notes is not installed after adb install — nothing was deployed." >&2
    exit 1
  }
  echo "Done. Installed release FUTO Notes (com.futo.notes)."

# Build a RELEASE native iOS build and install it on a connected iPhone
# (production bundle id com.futo.notes). DEBUG device installs go through
# `just ios-native-device`; the simulator through `just ios-native`.
deploy-ios:
  apps/ios/deploy.sh
