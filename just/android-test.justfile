# Android instrumentation (device) tests: the fast `am instrument` loop and the
# full Gradle path. Rationale: docs/agents/android-device-tests.md.

# `direct` only: the flavors compile the same androidTest sources against the
# same applicationId, so running both would install one over the other for no
# extra signal. This is the full Gradle path (CI parity, results as JUnit XML):
# every call rebuilds, reinstalls and uninstalls. To iterate, use test-android-ui.
# Instrumentation tests via Gradle connectedDirectDebugAndroidTest (slow, full cycle); optional Class[#method] selectors.
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
  # One selector is a plain class filter; several go as one tests_regex, because
  # AGP 9's test engine splits runner arguments on commas and silently ran only
  # the first class of `class=A,B` (android-instrument.mjs, gradleSelectorArg).
  SELECTOR_ARG="$(node scripts/android-instrument.mjs --gradle-arg "$@")"
  if [ -n "$SELECTOR_ARG" ]; then TEST_ARGS+=("$SELECTOR_ARG"); fi
  # The Compose tests drive the bundled editor.html: rebuild it first (L1-008).
  node_modules/.bin/vite build --config vite.editor.config.ts
  node scripts/qa.mjs android-target
  # Connected tests uninstall the app: claimed emulators only, never a phone.
  node scripts/android-instrument.mjs --assert-emulator
  RESULTS=apps/android/app/build/outputs/androidTest-results/connected
  rm -rf "$RESULTS"
  (cd apps/android && ./gradlew :app:connectedDirectDebugAndroidTest ${TEST_ARGS[@]+"${TEST_ARGS[@]}"})
  # M11: the task can pass with tests missing; every selector must have run.
  node scripts/android-instrument.mjs --check-junit "$RESULTS" "$@"

# The FAST device-test loop. Builds the app + test APKs for the emulator's ABI
# only, and skips the build entirely when nothing in the worktree changed since
# the last one (key: HEAD + diff + untracked files + build env + ABI; --rebuild
# forces it). Then android-instrument.mjs installs only APKs that differ from
# what is on the device, clears app data, and runs every selector in ONE
# `am instrument` — no Gradle, no uninstall. --shard runs the same selection
# split across every emulator this worktree claimed (qa-claim android --extra).
# FAST instrumentation tests: build once, install if changed, run any classes/methods/packages; --shard, --rebuild.
test-android-ui *args: _preflight-android android-env-check
  #!/usr/bin/env bash
  set -euo pipefail
  ARGS=()
  REBUILD=0
  for arg in "$@"; do
    case "$arg" in
      --rebuild) REBUILD=1 ;;
      -h|--help) exec node scripts/android-instrument.mjs --help ;;
      *) ARGS+=("$arg") ;;
    esac
  done
  # Selectors, the claim and its emulator-only rule are checked before building.
  node scripts/android-instrument.mjs --targets ${ARGS[@]+"${ARGS[@]}"} >/dev/null
  ABI="$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
  [ -n "$ABI" ] || { echo "cannot read the ABI of $ANDROID_SERIAL" >&2; exit 1; }
  APKS=(apps/android/app/build/outputs/apk/direct/debug/app-direct-debug.apk
    apps/android/app/build/outputs/apk/androidTest/direct/debug/app-direct-debug-androidTest.apk)
  STAMP=apps/android/app/build/futo-test-android-ui.stamp
  build_key() {
    {
      git rev-parse HEAD
      git diff HEAD --binary
      git ls-files -z --others --exclude-standard | xargs -0 -r sha256sum
      env | grep -E '^(FUTO_|VITE_|ABIS=|VERSION_)' | sort || true
      echo "abi=$ABI"
      sha256sum "${APKS[@]}" 2>/dev/null || echo "no apks"
    } | sha256sum | cut -d' ' -f1
  }
  if [ "$REBUILD" = 0 ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$(build_key)" ]; then
    echo "==> nothing changed since the last build for $ABI; skipping it (--rebuild forces one)"
  else
    rm -f "$STAMP"
    ABIS="$ABI" bash scripts/build-rust-android.sh
    # The Compose tests drive the bundled editor.html: rebuild it first (L1-008).
    node_modules/.bin/vite build --config vite.editor.config.ts
    (cd apps/android && ./gradlew :app:assembleDirectDebug :app:assembleDirectDebugAndroidTest "-PfutoAbis=$ABI")
    build_key > "$STAMP"
  fi
  node scripts/android-instrument.mjs ${ARGS[@]+"${ARGS[@]}"}
