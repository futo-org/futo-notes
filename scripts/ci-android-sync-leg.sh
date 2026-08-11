#!/usr/bin/env bash
set -euo pipefail
# Run the cross-platform sync harness's native-Android leg in CI: boot the
# baked emulator, install the debug APK built by build:android-native, and drive
# the desktop<->Android scenarios against a real device.
#
# The desktop<->desktop mesh is NOT re-run here (test:cross-platform-sync owns
# it), so this uses --android-only, which also makes a missing or unusable
# device fail red instead of skipping — an emulator is this job's whole purpose
# (AGENTS.md M11).

: "${CI_PROJECT_DIR:?CI_PROJECT_DIR is required}"
: "${ANDROID_HOME:?ANDROID_HOME is required}"

# Port 5556 keeps this emulator off 5554, which build:android-native's
# instrumentation run uses; --read-only below lets both share the "ci" AVD.
export ANDROID_EMULATOR_PORT="${ANDROID_EMULATOR_PORT:-5556}"
# The harness calls bare `adb`.
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# shellcheck source=scripts/ci-android-emulator.sh
source "$CI_PROJECT_DIR/scripts/ci-android-emulator.sh"

APK="$CI_PROJECT_DIR/apps/android/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.futo.notes.dev"

# The APK arrives as a build:android-native artifact. Absent means that job did
# not run for this pipeline (check its changes: gate) — this job cannot do its
# work without it, so fail loudly rather than skipping the scenarios.
if [[ ! -f "$APK" ]]; then
  echo "ERROR: debug APK not found at $APK" >&2
  echo "  It comes from build:android-native's artifacts — confirm this job's" >&2
  echo "  needs: lists that job and that its changes: gate matched." >&2
  exit 1
fi

report_failure() {
  local status=$?
  trap - EXIT
  ci_emulator_log_tail
  ci_emulator_stop
  exit "$status"
}

trap report_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --read-only: an ephemeral userdata overlay, so this instance can coexist with
# a --wipe instrumentation emulator on the same runner and AVD.
ci_emulator_start --read-only

# -r replaces a copy left by an earlier run; -g pre-grants runtime permissions
# so no system dialog can sit in front of the UI the harness drives.
"$ADB" -s "$ANDROID_SERIAL" install -r -g "$APK"

if ! "$ADB" -s "$ANDROID_SERIAL" shell pm list packages | tr -d '\r' | grep -qx "package:$PACKAGE"; then
  echo "ERROR: $PACKAGE is not installed after adb install" >&2
  exit 1
fi
echo "Installed $PACKAGE on $ANDROID_SERIAL"

# The desktop client in this leg is a real Tauri window, so it needs a display;
# software GL because xvfb exposes no GPU and WebKitGTK renders nothing without
# some GL path.
WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a --server-args="-screen 0 1280x800x24" \
  node "$CI_PROJECT_DIR/tests/cross-platform-sync.mjs" --android-only

trap - EXIT
ci_emulator_stop
