#!/usr/bin/env bash
# Boot and tear down a headless Android emulator in CI.
#
# SOURCED, not executed, by every CI script that needs a device:
# ci-android-instrumentation.sh (Compose instrumentation) and
# ci-android-sync-leg.sh (desktop<->Android cross-platform sync). One copy so
# the boot flags, KVM detection and readiness wait cannot drift between them.
#
# Caller contract:
#   CI_PROJECT_DIR         required — the emulator log is written under it
#   ANDROID_HOME           required — SDK root with platform-tools/ and emulator/
#   ANDROID_CI_AVD         AVD name (default "ci"; baked into ci/android.Dockerfile)
#   ANDROID_EMULATOR_PORT  even adb port (default 5554). Two emulators on one
#                          runner MUST use different ports.
#
# ci_emulator_start sets ANDROID_SERIAL, ADB, EMULATOR_LOG and EMULATOR_PID in
# the caller's shell, so the caller can drive adb and tail the log on failure.

: "${CI_PROJECT_DIR:?CI_PROJECT_DIR is required}"
: "${ANDROID_HOME:?ANDROID_HOME is required}"

AVD_NAME="${ANDROID_CI_AVD:-ci}"
EMULATOR_PORT="${ANDROID_EMULATOR_PORT:-5554}"
export ANDROID_SERIAL="emulator-$EMULATOR_PORT"

ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
EMULATOR_LOG="$CI_PROJECT_DIR/android-emulator-$EMULATOR_PORT.log"
EMULATOR_PID=""

# Boot the AVD headless and wait until adb reports it fully booted.
#
# $1 selects how the userdata image is handled:
#   --wipe       reset the AVD's userdata (exclusive: takes the AVD lock)
#   --read-only  ephemeral overlay over the AVD's userdata, so this instance can
#                run alongside another one using the SAME AVD
ci_emulator_start() {
  local userdata_mode="${1:?ci_emulator_start needs --wipe or --read-only}"
  local userdata_flag
  case "$userdata_mode" in
    --wipe) userdata_flag=-wipe-data ;;
    --read-only) userdata_flag=-read-only ;;
    *)
      echo "ERROR: unknown userdata mode '$userdata_mode'" >&2
      return 1
      ;;
  esac

  # Hardware acceleration needs /dev/kvm exposed into the job container (the
  # office runner's android_kvm tag). Without it the emulator still boots under
  # full emulation, just far slower — so check, don't assume.
  local acceleration=(-accel off)
  if [[ "$(uname -s)" == "Darwin" || (-r /dev/kvm && -w /dev/kvm) ]]; then
    acceleration=(-accel on)
  else
    echo "WARNING: /dev/kvm is not usable — booting the emulator unaccelerated"
  fi

  "$EMULATOR" \
    -avd "$AVD_NAME" \
    -port "$EMULATOR_PORT" \
    -no-window \
    -no-audio \
    -no-boot-anim \
    -no-snapshot \
    "$userdata_flag" \
    -gpu swiftshader_indirect \
    "${acceleration[@]}" \
    >"$EMULATOR_LOG" 2>&1 &
  EMULATOR_PID=$!

  # Wait on the boot-completed property, not a fixed sleep (M15). 6 minutes
  # covers an unaccelerated cold boot.
  local booted=false attempt device_state boot_completed
  for attempt in $(seq 1 180); do
    if ! kill -0 "$EMULATOR_PID" >/dev/null 2>&1; then
      echo "ERROR: Android emulator exited before boot completed" >&2
      return 1
    fi

    device_state="$("$ADB" -s "$ANDROID_SERIAL" get-state 2>/dev/null || true)"
    boot_completed="$("$ADB" -s "$ANDROID_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
    if [[ "$device_state" == "device" && "$boot_completed" == "1" ]]; then
      booted=true
      break
    fi
    if ((attempt % 15 == 0)); then
      echo "Waiting for Android emulator boot (${attempt}/180)"
    fi
    sleep 2
  done

  if [[ "$booted" != true ]]; then
    echo "ERROR: Android emulator did not finish booting within 6 minutes" >&2
    return 1
  fi
  echo "Android emulator $ANDROID_SERIAL booted ($userdata_mode)"
}

# Print the emulator log so a red job carries its own diagnosis.
ci_emulator_log_tail() {
  if [[ -f "$EMULATOR_LOG" ]]; then
    tail -200 "$EMULATOR_LOG"
  fi
}

ci_emulator_stop() {
  set +e
  "$ADB" -s "$ANDROID_SERIAL" emu kill >/dev/null 2>&1
  if [[ -n "$EMULATOR_PID" ]] && kill -0 "$EMULATOR_PID" >/dev/null 2>&1; then
    kill "$EMULATOR_PID" >/dev/null 2>&1
    wait "$EMULATOR_PID" >/dev/null 2>&1
  fi
  rm -f "$EMULATOR_LOG"
  set -e
}
