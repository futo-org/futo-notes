# Native iOS and Android shells: builds, tests, device stories, and release installs. Imported by the root justfile.

# ── Native mobile shells (SwiftUI / Compose — the SHIPPING mobile apps; AGENTS.md M2) ──

# Every shipped ABI by default; `device` builds only the connected device's, as
# the dev recipes do. An ABIS env var overrides both.
# Build futo-notes-ffi + Kotlin bindings for Android (needs cargo-ndk).
build-rust-android abis="":
  ABIS="${ABIS:-{{abis}}}" bash scripts/build-rust-android.sh

# Build the same Rust FFI xcframework for the native iOS app.
build-rust-ios:
  bash scripts/build-rust-ios.sh

# Requires Android SDK + NDK + cargo-ndk + a device/emulator. Builds the
# `direct` distribution flavor; `FUTO_ANDROID_FLAVOR=play just android-native`
# installs the Google Play flavor instead (same applicationId, so it replaces
# whichever is installed). FUTO_HOSTED_SERVER, if set, switches the FFI build to
# the `dev` profile (the only one that honors the override) and launches
# already pointed at that address — see docs/qa/hosted-sync-android.md.
# Build + run the native Android Compose app (Rust core + WebView editor).
android-native: _preflight-android
  apps/android/run.sh

# Build + run the native iOS app on the booted SIMULATOR (no signing).
# FUTO_LICENSE_ENV=production|staging (any build, any platform) forces the
# license org regardless of bundle id, e.g. a .dev app doing a real prod purchase.
ios-native: _preflight-ios
  apps/ios/run.sh

# Build + run the native iOS app on a connected PHYSICAL iPhone (Debug, signed).
ios-native-device: _preflight-ios
  apps/ios/run-device.sh

# Compile-only sanity for the native iOS app (no install); `just ios-native` runs it.
build-ios-native: _preflight-ios build-rust-ios
  #!/usr/bin/env bash
  set -euo pipefail
  # Debug app: the editor bundle carries the puppet inspector; see justfile-notes.md.
  VITE_INCLUDE_TEST_HOOKS=true node_modules/.bin/vite build --config vite.editor.config.ts
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
build-android-native: _preflight-android android-env-check (build-rust-android "device")
  #!/usr/bin/env bash
  set -euo pipefail
  # Debug app: the editor bundle carries the puppet inspector (see build-ios-native).
  VITE_INCLUDE_TEST_HOOKS=true node_modules/.bin/vite build --config vite.editor.config.ts
  cd apps/android
  ./gradlew :app:assembleDirectDebug :app:assemblePlayDebug

[private]
_preflight-ios: editor-deps
  @bash scripts/dev-env.sh node scripts/setup-worktree.mjs ios --check

[private]
_preflight-android: editor-deps
  @bash scripts/dev-env.sh node scripts/setup-worktree.mjs android --check

# ── Native unit tests ──

# The unit and UI recipes build the Rust bridge in `dev`, like `just ios-native`,
# so testing and running share one build; `-full` builds `release-ffi`, as CI
# does. An explicit FUTO_IOS_FFI_PROFILE overrides either.
# iOS unit tests (Swift Testing, FutoNotesNativeTests) — CI's MR tier; name suites to run only those.
test-ios-native *suites:
  FUTO_IOS_FFI_PROFILE="${FUTO_IOS_FFI_PROFILE:-dev}" python3 scripts/ios-test-session.py -- just _test-ios FutoNotesNativeTests "$@"

# iOS UI tests (XCTest, FutoNotesNativeUITests; minutes per run); name test classes to run only those.
test-ios-native-ui *classes:
  FUTO_IOS_FFI_PROFILE="${FUTO_IOS_FFI_PROFILE:-dev}" python3 scripts/ios-test-session.py -- just _test-ios FutoNotesNativeUITests "$@"

# iOS unit + UI tests together — what main pushes and tags run in CI.
test-ios-native-full:
  FUTO_IOS_FFI_PROFILE="${FUTO_IOS_FFI_PROFILE:-release-ffi}" python3 scripts/ios-test-session.py -- just _test-ios all

# Inspect this worktree's native iOS test process, including diagnostic collection.
ios-test-status:
  @python3 scripts/ios-test-session.py --status

# Clear only stale session metadata; the OS refuses this while the test lock is held.
ios-test-clear-stale:
  @python3 scripts/ios-test-session.py --clear-stale

# Runs on a CONCRETE simulator ($SIM, else the booted one). `bundle` is a test
# target, or `all`; each further argument narrows to one suite/class in it.
[private]
_test-ios bundle *names: _preflight-ios build-rust-ios
  #!/usr/bin/env bash
  set -euo pipefail
  BUNDLE="$1"; shift
  ONLY_TESTING=()
  if [ "$BUNDLE" != all ]; then
    DIR=apps/ios/Tests; [ "$BUNDLE" = FutoNotesNativeUITests ] && DIR=apps/ios/UITests
    [ $# -eq 0 ] && ONLY_TESTING=("-only-testing:$BUNDLE")
    for name in "$@"; do
      # xcodebuild runs zero tests and reports success for a name it does not know.
      grep -rqwE "(struct|class|enum|actor) ${name%%/*}" "$DIR" \
        || { echo "No suite or class named '${name%%/*}' in $DIR" >&2; exit 1; }
      ONLY_TESTING+=("-only-testing:$BUNDLE/$name")
    done
  fi
  # The test host IS the Debug app, so its editor bundle carries the puppet inspector too.
  VITE_INCLUDE_TEST_HOOKS=true node_modules/.bin/vite build --config vite.editor.config.ts
  SIM="${SIM:-$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-Fa-f-]\{36\}\)).*Booted.*/\1/p' | head -1)}"
  if [ -z "$SIM" ]; then
    echo "No simulator — set SIM=<udid> or run: just qa-claim ios" >&2
    exit 1
  fi
  echo "==> Simulator: $SIM"
  # UI tests switch accessibility off; the puppet listener needs it on. See justfile-notes.md.
  trap 'xcrun simctl spawn "$SIM" defaults write com.apple.Accessibility ApplicationAccessibilityEnabled -bool true' EXIT
  cd apps/ios
  xcodegen generate
  # A pool simulator whose runtime does not match Xcode (iOS 26.5 under Xcode
  # 27.1) has no usable local StoreKit: the StoreKit suites skip, visibly,
  # rather than fail or hang. CI does not set this, so there it stays a failure.
  export TEST_RUNNER_FUTO_STOREKIT_TESTS_OPTIONAL=1
  # Concrete destination + ad-hoc sign: see justfile-notes.md.
  # Avoid the optional multi-minute simctl sysdiagnose after a local test failure.
  # Ordinary test output, failure status and result bundles remain available.
  xcodebuild test -project FutoNotesNative.xcodeproj \
    -collect-test-diagnostics "${FUTO_IOS_TEST_DIAGNOSTICS:-never}" \
    -scheme FutoNotesNative \
    ${ONLY_TESTING[@]+"${ONLY_TESTING[@]}"} \
    -destination "id=$SIM" \
    -derivedDataPath .build \
    CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="-" 2>&1 | awk '
      { print; fflush() }
      /Executed [1-9][0-9]* tests?/ || /Test run with [1-9][0-9]* tests?/ { ran = 1 }
      END { if (!ran) { print "No iOS tests executed" > "/dev/stderr"; exit 1 } }
    '

# Write this build host's Debug collector port into an iOS built resource directory.
ios-dev-ports output configuration="Debug":
  node scripts/ios-dev-ports.mjs "$@"

# JVM unit tests under BOTH flavors; optional Gradle Class[.method] patterns.
test-android-native *tests: _preflight-android android-env-check (build-rust-android "device")
  #!/usr/bin/env bash
  set -euo pipefail
  # Stages the CURRENT editor.html into the assets, like every other native
  # recipe: a stale gitignored copy would otherwise be what gets tested (L1-008).
  node_modules/.bin/vite build --config vite.editor.config.ts
  TEST_ARGS=()
  for task in :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest; do
    TEST_ARGS+=("$task")
    for selector in "$@"; do
      TEST_ARGS+=(--tests "$selector")
    done
  done
  cd apps/android
  ./gradlew "${TEST_ARGS[@]}"

# `direct` only: the flavors compile the same androidTest sources against the
# same applicationId, so running both would install one over the other for no
# extra signal.
# Runs Compose instrumentation tests on $ANDROID_SERIAL; optional fully qualified Class[#method] selectors.
test-android-native-ui *classes: qa-android-target _preflight-android android-env-check (build-rust-android "device")
  #!/usr/bin/env bash
  set -euo pipefail
  TEST_ARGS=()
  SELECTOR_RE='^([[:alpha:]_$][[:alnum:]_$]*\.)+[[:alpha:]_$][[:alnum:]_$]*(#[[:alpha:]_$][[:alnum:]_$]*)?$'
  for selector in "$@"; do
    if [[ ! "$selector" =~ $SELECTOR_RE ]]; then
      echo "Expected a fully qualified Android test class, optionally #method: $selector" >&2
      exit 2
    fi
  done
  if [ "$#" -gt 0 ]; then
    TEST_ARGS+=("-Pandroid.testInstrumentationRunnerArguments.class=$(IFS=,; printf '%s' "$*")")
  fi
  # The Compose tests drive the bundled editor.html: rebuild it first (L1-008).
  node_modules/.bin/vite build --config vite.editor.config.ts
  node scripts/qa.mjs android-target
  cd apps/android
  ./gradlew :app:connectedDirectDebugAndroidTest ${TEST_ARGS[@]+"${TEST_ARGS[@]}"}

# Editor performance stories against the REAL native Android app on an
# explicitly claimed device — written for the low-end reference phone, where
# the budgets are hardest (issue #106, docs/plan/milkdown-transition.md §5):
# interactive-first-viewport <1s and keystroke p95 <16ms at real-note sizes,
# open that scales linearly with no cliff, the first focus after an open
# under 1s (the tap that starts typing), and the save at 1k/10k lines (a warm
# save p95 <16ms, a cold whole-document save with no cliff). The
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
  # The bundle that ships: no puppet inspector, whose trace wraps every listener.
  VITE_INCLUDE_TEST_HOOKS=false just android-native
  node tests/android-editor-perf.mjs "$@"

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
  node tests/android-editor-perf-quick.mjs "$@"

# Storage-migration stories on the REAL app; CLEARS debug data — claim a device first.
test-android-storage:
  node tests/android-storage-migration.mjs

# Editor stories (sustained typing, wikilink pop) against the REAL native iOS app (needs a claimed $SIM).
test-ios-stories:
  #!/usr/bin/env bash
  set -euo pipefail
  [ -n "${SIM:-}" ] || { echo 'No claimed simulator — run: eval "$(just qa-claim ios)"' >&2; exit 1; }
  command -v "${AXE_BIN:-axe}" >/dev/null || { echo "AXe is missing; install it or set AXE_BIN before building (see the verify iOS playbook)." >&2; exit 1; }
  SIM="$SIM" just ios-native
  SIM="$SIM" node tests/ios-editor-stories.mjs

# Build a RELEASE-signed Android build of one flavor and install it (com.futo.notes).
# Defaults to `direct` (GitLab/Obtainium/F-Droid); `just deploy-android play` installs
# the Google Play flavor instead. Needs apps/android/keystore.properties (gitignored)
# or Gradle signs nothing; see justfile-notes.md. NOTE: kept — asserted live by
# scripts/premerge-test-parity-mobile.test.mjs; do not remove as an unused recipe.
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
  # No `grep -q`: pipefail + early exit SIGPIPEs adb and reads as "not installed".
  adb shell pm list packages | grep -x 'package:com.futo.notes' >/dev/null || {
    echo "com.futo.notes is not installed after adb install — nothing was deployed." >&2
    exit 1
  }
  echo "Done. Installed release FUTO Notes (com.futo.notes)."

# Build a RELEASE native iOS build and install it on a connected iPhone (com.futo.notes).
deploy-ios:
  apps/ios/deploy.sh

# Regenerate selectable mobile icon catalogs, adaptive layers, and previews.
app-icons:
  node scripts/generate-app-icons.mjs

# Run current source on an isolated Mac checkout (including targeted native UI classes).
ios-remote *args: check-node-version
  @node scripts/ios-remote.mjs "$@"
