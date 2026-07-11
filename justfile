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
alias ts := test-shared
alias l := lint
alias c := check
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

# Lint the hand-written Swift sources (read-only) with swift-format, which
# ships with Xcode 16+ (`xcrun swift-format`). The generated UniFFI bindings
# (Sources/Generated) are excluded — they are not ours to style.
lint-swift:
  find apps/ios/Sources -name '*.swift' -not -path '*/Generated/*' -print0 \
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

# Swift Testing for the native iOS app — needs the FutoNotesNativeTests target
# (apps/ios/MODERNIZATION_PLAN.md, workstream D), not added yet, so until then
# xcodebuild reports "no test action".
test-ios-native: build-rust-ios
  #!/usr/bin/env bash
  set -euo pipefail
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/ios
  xcodegen generate
  xcodebuild test -project FutoNotesNative.xcodeproj \
    -scheme FutoNotesNative \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath .build

# JVM unit tests for the native Android app (e.g. SyncManagerDefaultsTest).
# Depends on build-rust-android so the UniFFI Kotlin bindings (gitignored)
# exist — compiling the app module needs them.
test-android-native: build-rust-android
  cd apps/android && ./gradlew testDebugUnitTest

# ── Parallel QA isolation (multiple worktrees, one machine) ──
# Worktree path → slot → pooled devices (futo-qa-0..6 per platform) + a
# per-slot sync server with its own Postgres database. Your personal
# simulators/AVDs are never touched. See scripts/qa.mjs and the /verify
# skill's "Isolation model" section.

# Claim (create + boot if needed) this worktree's pooled simulator/emulator.
# Prints `export SIM=…` / `export ANDROID_SERIAL=…` — eval or copy them.
qa-claim target="all":
  @node scripts/qa.mjs claim {{target}}

# Show pool devices + per-slot sync servers, and which worktree owns each.
qa-status:
  @node scripts/qa.mjs status

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

# Boot an iOS simulator by name (no-op if already booted) and wait for it.
sim-boot name="iPhone 17 Pro":
  #!/usr/bin/env bash
  set -euo pipefail
  xcrun simctl boot '{{name}}' 2>/dev/null || true  # "already booted" is fine
  open -a Simulator
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
  for i in $(seq 1 60); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && echo "Booted." && exit 0
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
  adb logcat -s FutoStartup FutoSearch NotesStore FutoToolbarDBG FutoBridgeDBG AndroidRuntime

# Debug builds only; re-run after every app restart (the WebView pid changes).
# adb forward host ports are machine-global, so the port is per-worktree
# (9330 + slot; override with $CDP_PORT). cdp-invoke.mjs honors $CDP_PORT.
# Forward the Android app's WebView DevTools socket for cdp-invoke.mjs.
cdp-forward:
  #!/usr/bin/env bash
  set -euo pipefail
  SLOT=$(( $(printf "%d" "0x$(echo -n "$(git rev-parse --show-toplevel)" | md5sum | cut -c1-8)") % 50 ))
  PORT="${CDP_PORT:-$((9330 + SLOT))}"
  PID=$(adb shell pidof com.futo.notes.dev | tr -d '\r')
  [ -n "$PID" ] || { echo "com.futo.notes.dev is not running — launch the app first." >&2; exit 1; }
  SOCKET=$(adb shell 'cat /proc/net/unix' | grep -o "webview_devtools_remote_${PID}" | head -1)
  [ -n "$SOCKET" ] || { echo "No DevTools socket for pid $PID — has the editor WebView been opened yet?" >&2; exit 1; }
  adb forward "tcp:${PORT}" "localabstract:${SOCKET}"
  echo "Forwarded localhost:${PORT} → ${SOCKET}"
  echo "  export CDP_PORT=${PORT}   # then: node scripts/cdp-invoke.mjs \"document.title\""

build:
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

test:
  pnpm run test:minimal

test-full:
  pnpm run test:full

test-unit:
  pnpm run test:unit

test-unit-full:
  pnpm run test:unit:full

test-shared:
  pnpm run test:shared

test-shared-full:
  pnpm run test:shared:full

test-e2e:
  pnpm run test:e2e:smoke

test-e2e-full:
  pnpm run test:e2e:full

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

test-rust-full:
  mkdir -p dist
  cargo test --workspace

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

# Regenerate the native shells' toolbar specs (apps/ios/Sources/ToolbarSpec.swift)
# from the @futo-notes/editor toolbar manifest (packages/editor/src/toolbar.ts —
# the single source of truth for the mobile toolbar surface).
toolbar-spec:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --write

# Fail if a generated native toolbar spec has drifted from the manifest.
toolbar-spec-check:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --check

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

# Remove native build artifacts (Xcode DerivedData + Gradle output + web dist)
# to reclaim disk. Leaves cargo `target/` alone (expensive to rebuild + shared).
clean:
  rm -rf dist
  rm -rf apps/ios/.build apps/ios/.build-device apps/ios/.build-device-release
  rm -rf apps/android/app/build apps/android/build

check: spec-gaps-check toolbar-spec-check check-command-reachability check-platform-discipline test-rust
  pnpm run lint
  pnpm run format:check
  pnpm run test:minimal
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

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
  # Kill running instance (comm is truncated to 15 chars, so use -f)
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
  node -e "const fs=require('fs'),f='${CONF}',c=JSON.parse(fs.readFileSync(f));c.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')"
  # Clean stale bundles so we never install an old one
  rm -rf "$BUNDLE_DIR"
  echo "Building .rpm package..."
  cd apps/tauri && cargo tauri build --bundles rpm
  cd ../..
  RPM=$(ls -t "${BUNDLE_DIR}"/*.rpm | head -1)
  # Kill running instance (comm is truncated to 15 chars, so use -f)
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${RPM}..."
  # `dnf install` no-ops when the version-release tuple already matches
  # (common at tag commits where VERSION === BASE_VER), leaving the
  # on-disk binary stale. Try reinstall first (replaces files when
  # already installed at the same version), fall back to install for
  # the fresh-install / upgrade / downgrade cases.
  sudo dnf reinstall -y "$RPM" 2>/dev/null || sudo dnf install -y "$RPM"
  # Restore tauri.conf.json so git stays clean
  git checkout -- "$CONF"
  echo "Done. Installed FUTO Notes ${VERSION}."

# Build a RELEASE native iOS build and install it on a connected iPhone
# (production bundle id com.futo.notes). DEBUG device installs go through
# `just ios-native-device`; the simulator through `just ios-native`.
deploy-ios:
  apps/ios/deploy.sh
