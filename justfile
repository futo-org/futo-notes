# `*args` is re-split by the shell unless quoted; recipes forwarding user text
# (a label, a pattern, a path) use "$@" instead — see docs/agents/justfile-notes.md.
set positional-arguments

default:
  @just --list --unsorted

alias i := install
alias td := tauri-dev
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

# Install pnpm dependencies.
install:
  pnpm install

# Provision pinned Node when needed, then install dependencies/check prerequisites.
setup *args:
  @bash scripts/dev-env.sh --install node scripts/setup-worktree.mjs "$@"

# Preserve a recipe's log, source identity and artifacts in a unique run directory.
verify-run +args:
  @node scripts/verify-run.mjs "$@"

# Lint the TypeScript/Svelte sources with ESLint.
lint:
  pnpm run lint

# Format the TypeScript/Svelte/JSON sources with Prettier.
format:
  pnpm run format

# Fail if any TypeScript/Svelte/JSON source is unformatted.
format-check:
  pnpm run format:check

# Format the Rust workspace (rustfmt, pinned by rust-toolchain.toml).
rust-format:
  cargo fmt --all

# Fail if any Rust file is unformatted.
rust-format-check:
  cargo fmt --all --check

# Lint hand-written Swift sources with swift-format (excludes generated bindings).
lint-swift:
  #!/usr/bin/env bash
  set -euo pipefail
  if [ "$(uname -s)" != "Darwin" ] || ! xcrun --find swift-format >/dev/null 2>&1; then
    echo "==> swift-format is unavailable on this host ($(uname -s)) — skipping Swift lint"
    exit 0
  fi
  find apps/ios/Sources apps/ios/Tests apps/ios/UITests \
    -name '*.swift' \
    -not -path '*/Generated/*' \
    -not -path '*/GeneratedContracts/*' \
    -not -path '*/GeneratedLocalization/*' \
    -print0 \
    | xargs -0 xcrun swift-format lint --strict --configuration apps/ios/.swift-format

# ── Desktop (Tauri) ──

# Desktop dev (Wayland, port 5180); `--fake-update[=X.Y.Z]` simulates an update banner.
[positional-arguments]
tauri-dev *args:
  node scripts/tauri-dev.mjs "$@"

# Build the desktop AppImage/bundle for this platform.
tauri-build:
  pnpm run build
  # NO_STRIP: linuxdeploy's strip can't read newer binutils' AppImages locally; see justfile-notes.md.
  cd apps/tauri && NO_STRIP=true cargo tauri build

# Read the desktop instance journal (JSONL); native shells don't journal yet.
[positional-arguments]
journal *args:
  @node scripts/journal.mjs "$@"

# ── Native mobile shells (SwiftUI / Compose — the SHIPPING mobile apps; AGENTS.md M2) ──

# Build futo-notes-ffi for all Android ABIs + Kotlin bindings (needs cargo-ndk).
build-rust-android:
  bash scripts/build-rust-android.sh

# Build the same Rust FFI xcframework for the native iOS app.
build-rust-ios:
  bash scripts/build-rust-ios.sh

# Requires Android SDK + NDK + cargo-ndk + a device/emulator. Builds the
# `direct` distribution flavor; `FUTO_ANDROID_FLAVOR=play just android-native`
# installs the Google Play flavor instead (same applicationId, so it replaces
# whichever is installed). FUTO_HOSTED_SERVER, if set, switches the FFI build to
# the `dev` profile (the only one that honours the override) and launches
# already pointed at that address — see docs/qa/hosted-sync-android.md.
# Build + run the native Android Compose app (Rust core + WebView editor).
android-native: _preflight-android
  apps/android/run.sh

# Build + run the native iOS app on the booted SIMULATOR (no signing).
ios-native: _preflight-ios
  apps/ios/run.sh

# Build + run the native iOS app on a connected PHYSICAL iPhone (Debug, signed).
ios-native-device: _preflight-ios
  apps/ios/run-device.sh

# Compile-only sanity for the native iOS app (no install); `just ios-native` runs it.
build-ios-native: _preflight-ios build-rust-ios
  #!/usr/bin/env bash
  set -euo pipefail
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/ios
  xcodegen generate
  # Generic destination: links both arches; see justfile-notes.md.
  BUILD_LOG="$(mktemp)"
  trap 'rm -f "$BUILD_LOG"' EXIT
  if xcodebuild -project FutoNotesNative.xcodeproj \
    -scheme FutoNotesNative -configuration Debug \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath .build \
    CODE_SIGNING_ALLOWED=NO build > "$BUILD_LOG" 2>&1; then
    tail -3 "$BUILD_LOG"
  else
    echo "==> xcodebuild failed:" >&2
    cat "$BUILD_LOG" >&2
    exit 1
  fi

# Fail fast (or self-install) when the JS deps a recipe needs are absent or
# stale — BEFORE the 10-25 minute Rust build, not after it. A fresh worktree's
# `just check` used to die on 'Command "tsx" not found' naming tsx, and
# `just test-ios-native` lost ~10 minutes of cold Rust builds to a missing
# node_modules/.bin/vite (pc_40406aa84bc1, pc_7aaa5ba6c080).
editor-deps:
  #!/usr/bin/env bash
  set -euo pipefail
  bash scripts/editor-deps.sh

# Refuse in ~2s — BEFORE the 10-25 minute Rust/FFI build — when this machine
# cannot run Gradle: no JDK 21 discoverable for Gradle's daemon-JVM pin
# (apps/android/gradle/gradle-daemon-jvm.properties — never fix this by
# exporting JAVA_HOME, see apps/android/AGENTS.md) or no Android SDK ("SDK
# location not found", the gitignored apps/android/local.properties is absent
# in a fresh worktree). Also writes local.properties from ANDROID_HOME/detected
# SDK. apps/android/run.sh sources the same script.
android-env-check:
  #!/usr/bin/env bash
  set -euo pipefail
  source scripts/android-env.sh

# Assembles BOTH distribution flavors' debug variants (direct =
# GitLab/Obtainium/F-Droid, play = Google Play) so a flavor-specific source set
# or buildConfigField that only breaks one of them fails here rather than at
# release time.
# Compile-only sanity for the native Android app (both flavors, no install).
build-android-native: _preflight-android android-env-check build-rust-android
  #!/usr/bin/env bash
  set -euo pipefail
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/android
  ./gradlew :app:assembleDirectDebug :app:assemblePlayDebug

[private]
_preflight-ios: editor-deps
  @bash scripts/dev-env.sh node scripts/setup-worktree.mjs ios --check

[private]
_preflight-android: editor-deps
  @bash scripts/dev-env.sh node scripts/setup-worktree.mjs android --check

# ── Native unit tests ──

# Swift Testing for the native iOS app on a CONCRETE simulator ($SIM, else the booted one).
test-ios-native: _preflight-ios build-rust-ios
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
  # Concrete destination + ad-hoc sign: see justfile-notes.md.
  xcodebuild test -project FutoNotesNative.xcodeproj \
    -scheme FutoNotesNative \
    -destination "id=$SIM" \
    -derivedDataPath .build \
    CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="-"

# JVM unit tests for the native Android app, under BOTH distribution flavors
# (DistributionFlavorTest asserts a per-flavor constant); see justfile-notes.md.
test-android-native: _preflight-android android-env-check build-rust-android
  cd apps/android && ./gradlew :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest

# `direct` only: the flavors compile the same androidTest sources against the
# same applicationId, so running both would install one over the other for no
# extra signal.
# Runs Compose instrumentation tests on $ANDROID_SERIAL.
test-android-native-ui: _preflight-android android-env-check build-rust-android
  cd apps/android && ./gradlew :app:connectedDirectDebugAndroidTest

# Editor performance stories against the REAL native Android app on an
# explicitly claimed device — written for the low-end reference phone, where
# the budgets are hardest (issue #106, docs/plan/milkdown-transition.md §5):
# interactive-first-viewport <1s and keystroke p95 <16ms at real-note sizes,
# open that scales linearly with no cliff, and the first focus after an open
# under 1s (the tap that starts typing). The
# build/install is deliberately mandatory so the run always exercises the code
# being pushed (same rule as test-ios-stories). The maintainer's largest real
# note joins the fixtures as a LOCAL, UNCOMMITTED file: $FUTO_PERF_NOTE=<path>,
# or drop it at tests/editor-gauntlet/local/device-perf-note.md (gitignored).
# Requires $ANDROID_SERIAL (a physical phone, or `just qa-claim android`).
# Deliberately not in `check`/CI — runners have no device.
#   just test-android-perf              # ~10 min on the reference phone
#   just test-android-perf --stress     # adds the 50k rung; 30 min+, see the runner
test-android-perf *args:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -n "${ANDROID_SERIAL:-}" ] || {
    echo 'Set ANDROID_SERIAL to the claimed device (the low-end reference phone; adb devices -l).' >&2
    echo 'Pool emulators: just qa-claim android' >&2
    exit 1
  }
  just android-native
  node tests/android-editor-perf.mjs {{args}}

# The FAST loop for the numbers above: the freshly built editor.html in the
# phone's own Chrome (same Chromium build as its System WebView), measured with
# the SAME in-page snippet the gate uses — no APK build, no install. Seconds per
# run instead of ~10 minutes, so it is what you iterate on; `test-android-perf`
# is what you confirm on. Also profiles: --profile (a keystroke) and
# --profile-open (the open) print where the CPU time went.
#   just test-android-perf-quick                                  # 1000-lines-blocks
#   just test-android-perf-quick --fixture 10000-lines-blocks --profile
test-android-perf-quick *args:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -n "${ANDROID_SERIAL:-}" ] || {
    echo 'Set ANDROID_SERIAL to the phone (adb devices -l).' >&2
    exit 1
  }
  node tests/android-editor-perf-quick.mjs {{args}}

# Storage-migration stories on the REAL app; CLEARS debug data — claim a device first.
test-android-storage:
  node tests/android-storage-migration.mjs

# Sustained-typing story against the REAL native iOS app (needs a claimed $SIM).
test-ios-stories:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -n "${SIM:-}" ] || { echo 'No claimed simulator — run: eval "$(just qa-claim ios)"' >&2; exit 1; }
  command -v "${AXE_BIN:-axe}" >/dev/null || { echo "AXe is missing; install it or set AXE_BIN before building (see the verify iOS playbook)." >&2; exit 1; }
  SIM="$SIM" just ios-native
  SIM="$SIM" node tests/ios-editor-stories.mjs

# ── Parallel QA isolation (multiple worktrees, one machine; model: scripts/qa.mjs) ──

# Claim (create + boot if needed) this worktree's pooled simulator/emulator.
[positional-arguments]
qa-claim target="all" *flags:
  @node scripts/qa.mjs claim "$@"

# Show pool devices + per-slot sync servers, and which worktree owns each.
qa-status:
  @node scripts/qa.mjs status

# Print every port this worktree owns.
ports:
  @node scripts/lib/slot.mjs

# Release this worktree's devices (add --shutdown to also power them off).
[positional-arguments]
qa-release *flags:
  @node scripts/qa.mjs release "$@"

# Reap pool devices/servers owned by worktrees that no longer exist.
qa-gc:
  @node scripts/qa.mjs gc

# Seed a QA worktree with a warm cargo build (APFS clone of target/).
qa-clone-target dest:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -d target ] || { echo "no target/ in $(pwd) — build here once first" >&2; exit 1; }
  [ -d '{{dest}}' ] || { echo "worktree '{{dest}}' does not exist" >&2; exit 1; }
  [ -e '{{dest}}/target' ] && { echo "'{{dest}}/target' already exists — remove it first" >&2; exit 1; }
  cp -Rc target '{{dest}}/target'
  echo "Cloned target/ → {{dest}}/target (APFS copy-on-write)"

# Start this worktree's isolated sync server (own port + own SQLite DB);
# --standin for hosted stand-in test mode — see docs/agents/justfile-notes.md.
qa-server *flags:
  @node scripts/qa.mjs server-start {{flags}}

# Stop it (add --drop to also delete its database and blobs).
[positional-arguments]
qa-server-stop *flags:
  @node scripts/qa.mjs server-stop "$@"

# ── Agent developer experience (worktrees, orientation, waiting; docs/plan/agent-dx.md) ──

# Create a sibling worktree with warm caches, list worktrees, or reap stale ones.
wt *args:
  #!/usr/bin/env bash
  exec node scripts/worktree.mjs "$@"

# Where am I: worktree, slot, ports, devices, dirty state, relevant papercuts.
orient *args:
  #!/usr/bin/env bash
  exec node scripts/agent-orient.mjs "$@"

# Block until a GitLab pipeline finishes; exit by its status; print failed traces.
ci-wait *args:
  #!/usr/bin/env bash
  exec node scripts/ci-wait.mjs wait "$@"

# Open MRs oldest first: iid, draft/ready, head-pipeline status, branch, title.
mr-status:
  @node scripts/ci-wait.mjs mr-status

# Run a long command detached with a durable log and exit file under .futo/runs/.
detached *args:
  #!/usr/bin/env bash
  exec node scripts/detached.mjs "$@"

# The weekly papercut sweep: a scheduled headless Opus session fixes tooling
# friction from .papercuts.jsonl; see scripts/papercut-sweep/README.md.
# Install the weekly papercut-sweep systemd user timer on this machine.
papercut-sweep-install:
  bash scripts/papercut-sweep/install-timer.sh

# One sweep now (`--dry-run` sets up the worktree and prints the prompt only).
papercut-sweep *args:
  #!/usr/bin/env bash
  exec node scripts/papercut-sweep/sweep.mjs "$@"

# ── Simulator / emulator QA helpers (mechanics; judgment lives in /verify's references/) ──

# Boot an iOS simulator by name (no-op if already booted) and wait for it.
sim-boot name="iPhone 17 Pro":
  #!/usr/bin/env bash
  set -euo pipefail
  xcrun simctl boot '{{name}}' 2>/dev/null || true  # "already booted" is fine
  # SHOW=1 foregrounds Simulator.app; headless by default. Xcode 27 ships no
  # Simulator.app — its replacement, DeviceHub, takes the touchscreen of EVERY
  # booted simulator while it runs, so refuse instead of opening it.
  if [ -n "${SHOW:-}" ] && ! open -a Simulator; then
    echo "SHOW=1: no Simulator.app (Xcode 27+). Not opening DeviceHub, which breaks scripted taps on every booted simulator; watch with: just sim-screenshot" >&2
    exit 1
  fi
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

# Screenshot the connected Android device/emulator → test-screenshots/<name>.png
emu-screenshot name="emu":
  @mkdir -p test-screenshots
  adb exec-out screencap -p > 'test-screenshots/{{name}}.png'

# Tag-scoped logcat for the native Android app's stable log tags.
emu-logs:
  # `adb logcat -c` first for a clean slate; crashes land under AndroidRuntime.
  adb logcat -s FutoStartup FutoSearch NotesStore FutoLicense FutoTestHook FutoToolbarDBG FutoBridgeDBG AndroidRuntime

# Forward the Android app's WebView DevTools socket for cdp-invoke.mjs.
cdp-forward:
  #!/usr/bin/env bash
  set -euo pipefail
  # Debug builds only; re-run after every app restart. Port derivation: justfile-notes.md.
  PORT="${CDP_PORT:-$(node scripts/lib/slot.mjs cdp)}"
  PID=$(adb shell pidof com.futo.notes.dev | tr -d '\r')
  [ -n "$PID" ] || { echo "com.futo.notes.dev is not running — launch the app first." >&2; exit 1; }
  SOCKET=$(adb shell 'cat /proc/net/unix' | grep -o "webview_devtools_remote_${PID}" | head -1)
  [ -n "$SOCKET" ] || { echo "No DevTools socket for pid $PID — has the editor WebView been opened yet?" >&2; exit 1; }
  adb forward "tcp:${PORT}" "localabstract:${SOCKET}"
  echo "Forwarded localhost:${PORT} → ${SOCKET}"
  echo "  export CDP_PORT=${PORT}   # then: node scripts/cdp-invoke.mjs \"document.title\""

# Drive the native Android app: read its state, tap labels, run debug hooks.
[positional-arguments]
android-drive *args:
  @node scripts/android-drive.mjs "$@"

# Fail fast in a fresh worktree instead of dying deep inside toolbar-spec-check.
_require-node-modules:
  @[ -d node_modules ] || { echo "No node_modules in this worktree — run: just install" >&2; exit 1; }

# Type-check + build the web app (pipefail so a failing tsc/vite can't hide behind `| tail`).
build: _require-node-modules
  #!/usr/bin/env bash
  set -euo pipefail
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

# Run the minimal (fast-loop) test suite.
test:
  pnpm run test:minimal

# Run ONE test file or -t pattern (installs deps if the worktree is fresh).
[positional-arguments]
test-one *args:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -d node_modules ] || { echo "==> node_modules missing — pnpm install"; pnpm install; }
  node_modules/.bin/vitest run "$@"

# Run unit tests (vitest, jsdom).
test-unit:
  pnpm run test:unit

# Run the editor package's test suite.
test-editor:
  pnpm run test:editor

# Run the Playwright smoke E2E suite.
test-e2e:
  pnpm run test:e2e:smoke

# EXACTLY what CI's test:e2e:rest job runs (everything but the P0 crash/IME spec).
test-e2e-rest:
  pnpm run test:e2e:rest

# Cross-platform E2EE sync against the pinned sync-server release.
test-cross-platform *args:
  pnpm run test:cross-platform "$@"

# The Rust server-backed sync suites against REAL servers (two server modes,
# both started on slot-derived ports, stopped by PID); see justfile-notes.md.
[positional-arguments]
test-sync-integration *args:
  node tests/sync-integration.mjs "$@"

# Run the markdown conformance/oracle suite.
test-markdown-spec:
  pnpm run test:markdown-spec

# Prove a chunked parse equals a whole-document parse, over a real note corpus;
# `--serialize` checks the other chunking equivalence claim. See justfile-notes.md.
chunk-census *args:
  node scripts/milkdown-chunk-census.mjs {{args}}

# Desktop smoke test (tests/AGENTS.md).
test-desktop-smoke:
  node tests/desktop-smoke.mjs


# Embedded debug app with test hooks; always build current web and Rust sources.
build-desktop-test:
  bash scripts/dev-env.sh node scripts/setup-worktree.mjs desktop --check
  VITE_INCLUDE_TEST_HOOKS=true just build
  # cargo clean -p so the build re-runs and re-embeds dist/ with the test
  # hooks: a futo-notes-tauri crate cached from a build without
  # VITE_INCLUDE_TEST_HOOKS can otherwise re-link a hooks-free binary. This
  # guard lived in the CI job script; it belongs here so every rebuild —
  # local or CI — gets it, and CI doesn't pay for a second identical build.
  cd apps/tauri && cargo clean -p futo-notes-tauri
  cargo build -p futo-notes-tauri

# Complete user journeys with a synthetic vault and real process restarts.
test-desktop-journeys: build-desktop-test
  node tests/desktop-journeys.mjs

# Rust conformance goldens + the TS↔Rust title-rules differential.
test-rust:
  cargo test -p futo-notes-model --test conformance
  cargo test -p futo-notes-license
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# The full Rust workspace + the differential.
test-rust-full:
  mkdir -p dist
  cargo test --workspace
  node --experimental-strip-types tests/conformance/title-rules-differential.mjs

# Shared search engine correctness; see crates/futo-notes-search/benches/search.rs.
[positional-arguments]
test-search *args:
  cargo test -p futo-notes-search "$@"

# Reproducible synthetic-vault benchmarks (Criterion; target/criterion). Override
# SEARCH_BENCH_NOTES for a different corpus size.
[positional-arguments]
bench-search *args:
  cargo bench -p futo-notes-search --bench search -- "$@"

# ── Remote (Linux) test execution over Tailscale; mechanism: scripts/remote-test.mjs ──
# `node scripts/remote-test.mjs --doctor|--help|<recipe>` runs any other portable recipe
# remotely (`--doctor` reports what jfedora has; `<recipe>` accepts `--rsync`/flags — see
# docs/remote-testing.md). `remote-sync` is the one wrapper kept as a `just` recipe.

# Cross-platform E2EE sync against the pinned sync-server release, remotely.
[positional-arguments]
remote-sync *flags:
  node scripts/remote-test.mjs "$@" test-cross-platform

# ── Editor gauntlet (the permanent editor regression suite) ──
# The matrix and oracles live behind EditorGauntletAdapter, with one adapter
# per editor. `gauntlet-milkdown*` drives the SAME single-file editor.html the
# native shells ship (it builds the bundle first).
# Reports land in tests/editor-gauntlet/local/ (gitignored). Full details,
# including corpus sharding: tests/editor-gauntlet/README.md.

# The 56-case split-torture matrix against Milkdown, scored against the ledger.
gauntlet-milkdown:
  pnpm run test:editor-gauntlet:milkdown

# Milkdown performance floor: hard budgets at real-note sizes, no cliff above.
gauntlet-milkdown-perf:
  pnpm run test:editor-gauntlet:milkdown:perf

# Read ~/Developer/futo-notes-ml/NOTICE.md first, then point it at a corpus:
#   EDITOR_GAUNTLET_CORPUS=~/Developer/futo-notes-ml/dataset/sample.jsonl \
#     EDITOR_GAUNTLET_CORPUS_LIMIT=100 just gauntlet-milkdown-foreign
# Milkdown foreign-corpus sweep (never-refuse/never-warn/never-lose).
gauntlet-milkdown-foreign *args:
  pnpm run test:editor-gauntlet:milkdown:foreign {{args}}

# ── Milkdown round-trip census ──
# Run a corpus of real notes through the real Milkdown editor and report what
# the round trip changed. This is the measurement behind the compat plugin set
# in packages/editor/src/milkdown-compat/ (docs/plan/milkdown-transition.md §3),
# and the way to prove a change to it costs nothing:
#
#   just milkdown-census --variant baseline          # the UNPATCHED upstream preset
#   just milkdown-census --diff build/milkdown-census/baseline
#   just milkdown-census --vault ~/Documents/futo-notes   # your own notes, locally
#   just milkdown-census --limit 200                 # quick smoke, ~4s
#
# ~30k notes in about 3 minutes on 12 pages. Output lands in
# build/milkdown-census/<variant>/ (gitignored) — results.jsonl carries the
# round-tripped text of FLAGGED notes, so a vault run's output is your notes:
# read it locally, never commit it. `--diff` exits non-zero on any newly raised
# flag. Corpus default: ~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz.
# Findings write-up: docs/editor/milkdown-roundtrip-census.md.
milkdown-census *args:
  node tests/milkdown-census/run.mjs {{args}}

# ── The FUTO supporter coin (Blender -> all three shells) ──
# The coin is ONE object, modelled in assets/coin/build-coin.py and exported to
# three files: futo-coin.glb (desktop three.js + Android Filament), futo-coin.usdz
# (iOS RealityKit) and studio-env.hdr, the small studio every shell reflects off
# it. Gold is a metal; a metal with nothing to reflect renders black, which is
# why the environment is an asset and not a nicety.
# Rebuild the coin from its Blender source (needs Blender 5.x on PATH).
coin:
  #!/usr/bin/env bash
  set -euo pipefail
  command -v blender >/dev/null || { echo "blender is not on PATH - install it (dnf install blender) or see assets/coin/build-coin.py" >&2; exit 1; }
  blender --background --factory-startup --python assets/coin/build-coin.py -- "$PWD/assets/coin"
  # Android's Filament needs the studio prefiltered into a cubemap; the other
  # two shells do that themselves at load time. Downloads a pinned cmgen once.
  node scripts/build-coin-ibl.mjs
  node scripts/check-coin-assets.mjs

# Fail if the exports no longer match build-coin.py, or were hand-edited (M8),
# and if scripts/lib/studio-env.mjs no longer rebuilds the shipped studio.
# Needs no Blender, which is why it can run in CI and in `just check`.
coin-check:
  node scripts/check-coin-assets.mjs

# Per-shell exposure (no regeneration), material roughness and colour, the room,
# and each of the five lamps. It reads out what percentage of the coin is blown
# out and will sweep 360 degrees to find the worst angle, so "too bright at some
# angles" becomes a number. Nothing is written to the repo: the page prints the
# constants and names the files to paste them into. Static server on a
# slot-derived port, Ctrl-C to stop.
# Play with every dial that decides how bright the supporter coin is.
coin-tuner:
  @node scripts/coin-tuner.mjs

# Regenerate the native toolbar specs from packages/editor/src/toolbar.ts.
toolbar-spec:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --write

# Fail if a generated native toolbar spec has drifted from the manifest.
toolbar-spec-check:
  pnpm exec tsx scripts/gen-toolbar-spec.ts --check

# Regenerate the native title-validation constants from packages/editor/src/filename.ts.
title-spec:
  pnpm exec tsx scripts/gen-title-spec.ts --write

# Fail if a generated native title spec has drifted from the manifest.
title-spec-check:
  pnpm exec tsx scripts/gen-title-spec.ts --check

# Fail on an unreachable or unregistered Tauri command (see the script for the allowlist).
check-command-reachability:
  node scripts/check-command-reachability.mjs

# Fail on a Tauri IPC import outside src/lib/platform/** (see the script for the allowlist).
check-platform-discipline:
  node scripts/check-platform-discipline.mjs

# Regenerate the native bridge-coverage specs from packages/editor/src/bridge.ts.
bridge-spec:
  pnpm exec tsx scripts/gen-bridge-spec.ts --write

# Fail if the generated native bridge specs have drifted from bridge.ts.
bridge-spec-check:
  pnpm exec tsx scripts/gen-bridge-spec.ts --check

# Generate TypeScript records from the Rust-owned Tauri sync IPC contract.
sync-contract:
  mkdir -p dist
  FUTO_UPDATE_SYNC_CONTRACT=1 cargo test -p futo-notes-tauri generated_typescript_contract_is_current

# Fail if the generated sync IPC contract has drifted.
sync-contract-check:
  mkdir -p dist
  cargo test -p futo-notes-tauri generated_typescript_contract_is_current

# Fail on a stale or missing entry in the drift registry (see the script for details).
check-drift:
  node scripts/drift-check.mjs

# Screenshot this worktree's desktop QA window WITHOUT activating it; see justfile-notes.md.
#   just qa-shot list | pid <pid> | port <port> [--out <path>]
[positional-arguments]
qa-shot *args:
  @node scripts/qa-shot.mjs "$@"

# Fail if any instruction surface teaches OS-level input or a process-name kill (see the script).
check-qa-input-safety:
  node scripts/check-qa-input-safety.mjs

# Fail if a theme swap repaints any surface at a different pace than the rest of the window.
check-theme-single-pace:
  node scripts/check-theme-single-pace.mjs

# Resolve a desktop QA target safely — the ONLY sanctioned port/PID → process lookup.
#   just qa-target list | status | pid <pid> | port <port> | kill
[positional-arguments]
qa-target *args:
  @node scripts/qa-target.mjs "$@"

# Fail on a broken `just`/`pnpm run`/repo-path reference in an instruction surface.
check-agent-docs:
  node scripts/check-agent-docs.mjs

# Run the focused architecture checks embedded in GitLab's mandatory test job.
arch-gate:
  pnpm run check:arch-gate

# Link installed third-party skills from .agents/skills/ into .claude/skills/ (idempotent).
skills-link:
  @node scripts/skills-link.mjs

# Restore the former vendored Swift references from a pinned repository snapshot.
# Optional, per-worktree, and refuses to overwrite any installed skill or link.
skills-swift:
  #!/usr/bin/env bash
  set -euo pipefail
  snapshot=3b1c43c139181b91b7384b478b5edec454b80190
  skills=(swiftui-expert-skill swift-concurrency-pro swift-testing-pro)
  git cat-file -e "$snapshot^{commit}"
  for skill in "${skills[@]}"; do
    for destination in ".agents/skills/$skill" ".claude/skills/$skill"; do
      if [[ -e "$destination" || -L "$destination" ]]; then
        echo "Already present: $destination; leaving installed skills unchanged." >&2
        exit 1
      fi
    done
  done
  mkdir -p .agents/skills .claude/skills
  staging=$(mktemp -d .agents/swift-install.XXXXXX)
  trap 'rm -rf "$staging"' EXIT
  git archive "$snapshot" "${skills[@]/#/.claude/skills/}" | tar -xf - --strip-components=2 -C "$staging"
  for skill in "${skills[@]}"; do
    test -f "$staging/$skill/SKILL.md"
  done
  for skill in "${skills[@]}"; do
    mv "$staging/$skill" ".agents/skills/$skill"
    ln -s "../../.agents/skills/$skill" ".claude/skills/$skill"
  done

# Validate the store release notes (all files, or one tag's); see justfile-notes.md.
#   just release-notes-check            # every committed file
#   just release-notes-check v1.7.2     # one tag
release-notes-check tag="":
  @node scripts/release-notes.mjs {{ if tag == "" { "--all" } else { "--tag " + tag + " --check" } }}

# ── Code-quality ratchet (big-code-analysis) ──
# Needs network on first run (downloads a pinned bca release into .bca-cache/);
# set BCA_BIN=/path/to/bca to use a prebuilt binary. Gates new/worsened
# complexity offenders against the committed .bca-baseline.toml. CI runs
# this same script non-blocking (docs/architecture-gates.md).
quality *args:
  node scripts/bca-quality.mjs {{args}}

# Remove native build artifacts (Xcode DerivedData + Gradle output + web dist) to reclaim disk.
clean:
  rm -rf dist
  rm -rf apps/ios/.build apps/ios/.build-device apps/ios/.build-device-release
  rm -rf apps/android/app/build apps/android/build

# Three independent fail-fast guards for the same "no node_modules" papercut,
# landed on parallel MR stacks; kept all rather than dropping any. Rationale:
# docs/agents/justfile-notes.md.
check-node-modules:
  @node scripts/check-node-modules.mjs

_require-install:
  @[ -d node_modules ] || { echo 'node_modules is missing in this worktree — run: just install' >&2; exit 1; }

# The normal pre-merge umbrella: specs, arch gates, Rust conformance, lint, tests, build.
check: check-node-modules _require-install _require-node-modules toolbar-spec-check title-spec-check coin-check arch-gate lint-swift test-rust rust-format-check
  #!/usr/bin/env bash
  # pipefail: see `build:` above — a failing tsc/vite build must not hide behind `| tail`.
  set -euo pipefail
  pnpm run lint
  pnpm run check:svelte
  pnpm run format:check
  pnpm run test:full
  pnpm exec tsc --noEmit | head -30
  pnpm run build | tail -20

# Maximal pre-push gate: `check` + full Rust workspace + full E2E + cross-platform sync.
prepush: check test-rust-full
  #!/usr/bin/env bash
  set -euo pipefail
  # --retries=1 absorbs the local 30s timeout's flakes, not real bugs; see justfile-notes.md.
  pnpm exec playwright test --retries=1
  pnpm run test:cross-platform
  bash scripts/run-ios-stories-if-available.sh
  echo "prepush green — check + rust workspace + full e2e + cross-platform sync + available iOS stories all passed"

# Build .deb from current repo state and install it.
deploy-deb:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  BUNDLE_DIR="target/release/bundle/deb"
  # Version = latest git tag + commit distance.
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
  rm -rf "$BUNDLE_DIR"
  echo "Building .deb package..."
  cd apps/tauri && cargo tauri build --bundles deb
  cd ../..
  DEB=$(ls -t "${BUNDLE_DIR}"/*.deb | head -1)
  # Single-checkout install: stops every FUTO Notes on the machine before
  # overwriting /usr/bin. NOT a QA-cleanup template — see justfile-notes.md.
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${DEB}..."
  sudo dpkg -i "$DEB"
  git checkout -- "$CONF"
  echo "Done. Installed FUTO Notes ${VERSION}."

# Build .rpm from current repo state and install it.
deploy-rpm:
  #!/usr/bin/env bash
  set -euo pipefail
  CONF="apps/tauri/src-tauri/tauri.conf.json"
  BUNDLE_DIR="target/release/bundle/rpm"
  # Version = latest git tag + commit distance.
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
  # Restore even on a red exit from the install assertion below; $ROOT because
  # the build step leaves us inside apps/tauri.
  trap 'git -C "$ROOT" checkout -- "$CONF"' EXIT
  rm -rf "$BUNDLE_DIR"
  echo "Building .rpm package..."
  cd apps/tauri && cargo tauri build --bundles rpm
  cd ../..
  RPM=$(ls -t "${BUNDLE_DIR}"/*.rpm | head -1)
  # Single-checkout install: stops every FUTO Notes on the machine before
  # overwriting /usr/bin. NOT a QA-cleanup template — see justfile-notes.md.
  pkill -f futo-notes-tauri 2>/dev/null && echo "Stopped running instance." && sleep 1 || true
  echo "Installing ${RPM}..."
  # rpm -U --force, not dnf reinstall (silently no-ops on a version mismatch); justfile-notes.md.
  if rpm -q futo-notes >/dev/null 2>&1; then
    sudo rpm -Uvh --force "$RPM"
  else
    sudo dnf install -y "$RPM"
  fi
  # Assert by sha256 against the package's own digest, not target/release/ (bundler strips it).
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

# Build a RELEASE-signed Android build of one flavor and install it (com.futo.notes).
# Defaults to `direct` (GitLab/Obtainium/F-Droid); `just deploy-android play` installs
# the Google Play flavor instead. Needs apps/android/keystore.properties (gitignored)
# or Gradle signs nothing; see justfile-notes.md. NOTE: kept — asserted live by
# scripts/premerge-test-parity.test.mjs; do not remove as an unused recipe.
deploy-android flavor="direct": editor-deps android-env-check
  #!/usr/bin/env bash
  set -euo pipefail
  case '{{flavor}}' in
    direct) VARIANT=Direct ;;
    play) VARIANT=Play ;;
    *) echo "flavor must be 'direct' or 'play' (got '{{flavor}}')" >&2; exit 1 ;;
  esac
  if [ ! -f apps/android/keystore.properties ]; then
    echo "No apps/android/keystore.properties — release builds cannot be signed." >&2
    echo "  A release APK without it is unsigned and will not install." >&2
    echo "  For a debug install on com.futo.notes.dev use: just android-native" >&2
    exit 1
  fi
  just build-rust-android
  node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/android && ./gradlew ":app:assemble${VARIANT}Release"
  APK=$(ls -t "app/build/outputs/apk/{{flavor}}/release"/*.apk | head -1)
  echo "Installing ${APK} (com.futo.notes)…"
  adb install -r "$APK"
  # Assert the PRODUCTION package landed, not a leftover .dev install.
  adb shell pm list packages | grep -qx 'package:com.futo.notes' || {
    echo "com.futo.notes is not installed after adb install — nothing was deployed." >&2
    exit 1
  }
  echo "Done. Installed release FUTO Notes (com.futo.notes)."

# Build a RELEASE native iOS build and install it on a connected iPhone (com.futo.notes).
deploy-ios:
  apps/ios/deploy.sh
