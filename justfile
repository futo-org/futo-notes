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

# Lint the hand-written Swift sources (read-only) with swift-format, which
# ships with Xcode 16+ (`xcrun swift-format`). The generated UniFFI bindings
# (Sources/Generated) are excluded — they are not ours to style.
lint-swift:
  find apps/ios/Sources -name '*.swift' -not -path '*/Generated/*' -print0 \
    | xargs -0 xcrun swift-format lint --strict --configuration apps/ios/.swift-format

# ── Desktop (Tauri) ──

tauri-dev:
  node scripts/tauri-dev.mjs

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
  mkdir -p apps/android/app/src/main/assets
  cp apps/ios/Resources/editor.html apps/android/app/src/main/assets/editor.html
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

# Remove native build artifacts (Xcode DerivedData + Gradle output + web dist)
# to reclaim disk. Leaves cargo `target/` alone (expensive to rebuild + shared).
clean:
  rm -rf dist
  rm -rf apps/ios/.build apps/ios/.build-device apps/ios/.build-device-release
  rm -rf apps/android/app/build apps/android/build

check: spec-gaps-check toolbar-spec-check test-rust
  pnpm run lint
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
