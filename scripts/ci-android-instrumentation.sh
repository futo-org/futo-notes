#!/usr/bin/env bash
set -euo pipefail

: "${CI_PROJECT_DIR:?CI_PROJECT_DIR is required}"
: "${ANDROID_HOME:?ANDROID_HOME is required}"

AVD_NAME="${ANDROID_CI_AVD:-ci}"
EMULATOR_PORT="${ANDROID_EMULATOR_PORT:-5554}"
export ANDROID_SERIAL="emulator-$EMULATOR_PORT"

ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
EMULATOR_LOG="$CI_PROJECT_DIR/android-emulator.log"
RESULTS_DIR="$CI_PROJECT_DIR/apps/android/app/build/outputs/androidTest-results/connected/debug"
EMULATOR_PID=""

cleanup() {
  set +e
  "$ADB" -s "$ANDROID_SERIAL" emu kill >/dev/null 2>&1
  if [[ -n "$EMULATOR_PID" ]] && kill -0 "$EMULATOR_PID" >/dev/null 2>&1; then
    kill "$EMULATOR_PID" >/dev/null 2>&1
    wait "$EMULATOR_PID" >/dev/null 2>&1
  fi
  rm -f "$EMULATOR_LOG"
}

report_failure() {
  local status=$?
  trap - EXIT
  if [[ -f "$EMULATOR_LOG" ]]; then
    tail -200 "$EMULATOR_LOG"
  fi
  cleanup
  exit "$status"
}

trap report_failure EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

acceleration=(-accel off)
if [[ "$(uname -s)" == "Darwin" || ( -r /dev/kvm && -w /dev/kvm ) ]]; then
  acceleration=(-accel on)
fi

"$EMULATOR" \
  -avd "$AVD_NAME" \
  -port "$EMULATOR_PORT" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot \
  -wipe-data \
  -gpu swiftshader_indirect \
  "${acceleration[@]}" \
  >"$EMULATOR_LOG" 2>&1 &
EMULATOR_PID=$!

booted=false
for attempt in $(seq 1 180); do
  if ! kill -0 "$EMULATOR_PID" >/dev/null 2>&1; then
    echo "ERROR: Android emulator exited before boot completed" >&2
    exit 1
  fi

  device_state="$("$ADB" -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)"
  boot_completed="$("$ADB" -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  if [[ "$device_state" == "device" && "$boot_completed" == "1" ]]; then
    booted=true
    break
  fi
  if (( attempt % 15 == 0 )); then
    echo "Waiting for Android emulator boot (${attempt}/180)"
  fi
  sleep 2
done

if [[ "$booted" != true ]]; then
  echo "ERROR: Android emulator did not finish booting within 6 minutes" >&2
  exit 1
fi

rm -rf "$RESULTS_DIR"
"$CI_PROJECT_DIR/apps/android/gradlew" \
  --project-dir "$CI_PROJECT_DIR/apps/android" \
  --no-daemon \
  :app:connectedDebugAndroidTest

result_file="$(find "$RESULTS_DIR" -name 'TEST-*.xml' -type f -print -quit 2>/dev/null || true)"
if [[ -z "$result_file" ]]; then
  echo "ERROR: connectedDebugAndroidTest produced no JUnit XML under $RESULTS_DIR" >&2
  exit 1
fi
if ! grep -rq '<testcase' "$RESULTS_DIR"; then
  echo "ERROR: Android instrumentation results contain no testcases" >&2
  exit 1
fi

testcase_count="$(grep -rho '<testcase' "$RESULTS_DIR" | wc -l | tr -d ' ')"
echo "Android instrumentation results OK: $testcase_count testcase(s)"

trap - EXIT
cleanup
