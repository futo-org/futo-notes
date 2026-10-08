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

  # -gpu swangle_indirect, NOT swiftshader_indirect. Both are software
  # rasterizers (no GPU in a CI container), but SwiftShader's own GLSL ES
  # compiler rejects Filament's post-process shaders — `Compilation error in
  # fragment shader "fxaa"` / `"blitLow"`, then `Fatal signal 6 (SIGABRT) in
  # FEngine::loop` — and Filament aborts rather than degrading when a material
  # fails to link. So the app process died the moment an instrumentation test
  # drew the supporter coin, taking the whole run with it
  # ("Instrumentation run failed due to Process crashed", job 255825). SwANGLE
  # routes GL through ANGLE onto SwiftShader's Vulkan device, and ANGLE's
  # translator compiles those shaders: the same run goes 10/10 green, coin
  # pixel assertion included. Reproduce either way locally with
  # `emulator -avd <name> -no-window -gpu <mode>`.
  "$EMULATOR" \
    -avd "$AVD_NAME" \
    -port "$EMULATOR_PORT" \
    -no-window \
    -no-audio \
    -no-boot-anim \
    -no-snapshot \
    "$userdata_flag" \
    -gpu swangle_indirect \
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

  ci_emulator_wait_framework_ready || return 1
  echo "Android emulator $ANDROID_SERIAL booted ($userdata_mode), framework ready (system_server pid $CI_EMULATOR_FRAMEWORK_PID)"
}

# ── The framework can restart after boot ─────────────────────
# sys.boot_completed is not the end of booting. The Android framework process
# (system_server) can die and start again AFTER it reads 1, and the property
# STAYS 1 across that restart, so any probe that passed a moment ago may have
# passed against the old process. test:cross-platform-sync:android lost 33 of
# 283 runs (2026-07-31..2026-10-08, all on runner 71) at `adb install`, right
# after every readiness probe below had passed, with one of:
#   cmd: Can't find service: package
#   cmd: Failure calling service package: Broken pipe (32)
#   IllegalStateException: Cannot access system provider: 'settings' before
#     system providers are installed!
#   NullPointerException ... PackageManagerInternal.freeStorage(...) on a null
#     object reference, at StorageManagerService.allocateBytes
#   NullPointerException ... StorageManager.getVolumes() on a null object
#     reference, at InstallLocationUtils.resolveInstallVolume (jobs 257114,
#     257078)
# Only a system_server that is still starting up can say any of those, and in
# the same runs the emulator's own post-boot `settings put` failed with "cmd:
# Can't find service: settings". The rate went from 2 of 150 runs to 31 of 133
# when -gpu swiftshader_indirect became swangle_indirect (2026-09-18), so the
# graphics stack is the likely trigger; ci_emulator_framework_report prints the
# init and crash lines that name it. `adb root && adb shell setprop ctl.restart
# zygote` reproduces every string above on demand: a new system_server pid,
# sys.system_server.start_count 1 -> 2, sys.boot_completed still 1.
#
# So readiness is checked per framework GENERATION (one system_server pid), and
# ci_emulator_install_apk survives one restart instead of trusting the probes.

# The running system_server's pid, or nothing while the framework is down.
ci_emulator_framework_pid() {
  "$ADB" -s "$ANDROID_SERIAL" shell pidof system_server 2>/dev/null | tr -d '\r' || true
}

# True once the system_server with pid $1 has finished booting. It writes
# boot_progress_enable_screen to the events log after ActivityManager is ready,
# i.e. after the boot phases that wire StorageManager and the system providers,
# and a restarted process writes its own under its own pid. awk reads the whole
# stream (no early exit to SIGPIPE adb under pipefail, RC-65).
ci_emulator_framework_booted() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  "$ADB" -s "$ANDROID_SERIAL" logcat -b events -d -v threadtime 2>/dev/null \
    | awk -v pid="$pid" '$3 == pid && $6 == "boot_progress_enable_screen:" { found = 1 } END { exit !found }'
}

# Wait, on conditions rather than a guessed sleep (M15), until the CURRENT
# framework generation can take an install, and record its pid in
# CI_EMULATOR_FRAMEWORK_PID. Each probe guards a failure seen in CI:
#   - the running system_server has finished booting (see above);
#   - the package service is registered. Matched EXACTLY: `service check`
#     answers "Service package: not found" while the framework is down, which a
#     *found* glob accepted (job 209306 is why the check exists at all);
#   - `pm install-create` succeeds. It walks the same createSessionInternal ->
#     resolveInstallVolume -> StorageManager path a real install does, without
#     writing anything (jobs 257114 / 257078); the session is abandoned;
#   - the pid is unchanged after the probes, so they all saw one generation.
CI_EMULATOR_FRAMEWORK_PID=""
ci_emulator_wait_framework_ready() {
  local attempt pid waiting_for="" session_output="" session_id
  for attempt in $(seq 1 90); do
    pid="$(ci_emulator_framework_pid)"
    if ! ci_emulator_framework_booted "$pid"; then
      waiting_for="system_server ${pid:-<not running>} to finish booting"
    elif [[ "$("$ADB" -s "$ANDROID_SERIAL" shell service check package 2>/dev/null | tr -d '\r')" != "Service package: found" ]] \
      || ! "$ADB" -s "$ANDROID_SERIAL" shell pm list packages >/dev/null 2>&1; then
      waiting_for="the package service"
    elif ! session_output="$("$ADB" -s "$ANDROID_SERIAL" shell pm install-create 2>&1)" \
      || [[ "$session_output" != *Success* ]]; then
      waiting_for="pm install-create (last output: ${session_output:-<none>})"
    else
      session_id="$(printf '%s' "$session_output" | grep -o '\[[0-9]*\]' | tr -d '[]')"
      if [[ -n "$session_id" ]]; then
        "$ADB" -s "$ANDROID_SERIAL" shell pm install-abandon "$session_id" >/dev/null 2>&1 || true
      fi
      if [[ "$(ci_emulator_framework_pid)" == "$pid" ]]; then
        CI_EMULATOR_FRAMEWORK_PID="$pid"
        return 0
      fi
      waiting_for="a framework that restarted during the probes"
    fi
    sleep 2
  done
  echo "ERROR: the emulator's Android framework was not ready after 3 minutes; still waiting for $waiting_for" >&2
  ci_emulator_framework_report >&2
  return 1
}

# Install an APK, surviving ONE framework restart. A restart that lands on the
# install (a failure carrying one of the signatures above, or a system_server
# pid that changed underneath a success) is waited out with the readiness gate
# and the install runs once more; a second restart, or any other install
# failure, is red. Extra arguments go to `adb install` (default -r -g).
ci_emulator_install_apk() {
  local apk="${1:?ci_emulator_install_apk needs an APK path}"
  shift
  local install_args=("$@")
  ((${#install_args[@]})) || install_args=(-r -g)
  local attempt output status pid_after
  for attempt in 1 2; do
    status=0
    output="$("$ADB" -s "$ANDROID_SERIAL" install "${install_args[@]}" "$apk" 2>&1)" || status=$?
    printf '%s\n' "$output"
    pid_after="$(ci_emulator_framework_pid)"
    if [[ "$status" -eq 0 && "$pid_after" == "$CI_EMULATOR_FRAMEWORK_PID" ]]; then
      return 0
    fi
    if [[ "$pid_after" == "$CI_EMULATOR_FRAMEWORK_PID" ]] && ! ci_emulator_framework_gone "$output"; then
      echo "ERROR: adb install failed (exit $status) while the framework stayed up" >&2
      return 1
    fi
    if ((attempt == 2)); then
      echo "ERROR: the Android framework restarted again during the retried install; not retrying twice" >&2
      ci_emulator_framework_report >&2
      return 1
    fi
    echo "Android framework restarted during adb install (system_server pid $CI_EMULATOR_FRAMEWORK_PID -> ${pid_after:-<not running>}); waiting for the new process, then installing once more"
    ci_emulator_framework_report
    ci_emulator_wait_framework_ready || return 1
  done
}

# True when adb output carries a signature of a framework that is down or
# still starting (the list above).
ci_emulator_framework_gone() {
  case "$1" in
    *"Can't find service"* | *"Failure calling service"* | *"DeadObjectException"* \
      | *"before system providers are installed"* | *"on a null object reference"*)
      return 0
      ;;
  esac
  return 1
}

# What the framework and init said about restarts — diagnostics only, so a
# missing device or an empty buffer is not an error here.
ci_emulator_framework_report() {
  echo "--- Android framework: sys.system_server.start_count=$("$ADB" -s "$ANDROID_SERIAL" shell getprop sys.system_server.start_count 2>/dev/null | tr -d '\r'), system_server pid=$(ci_emulator_framework_pid) ---"
  # Each zygote start is one framework generation; an onrestart line that
  # restarts zygote names the service whose death caused it; abnormal deaths
  # carry no "took" (boot-time oneshots exiting normally do), and zygote's own
  # children dying afterwards ("Untracked pid") are only the cascade.
  echo "--- init: framework starts and the deaths that caused them (first 20) ---"
  "$ADB" -s "$ANDROID_SERIAL" logcat -b all -d 2>/dev/null \
    | awk '/ init *: / && !/Untracked pid/ && (/starting service .zygote/ || (/onrestart/ && /zygote/) || ((/received signal|exited with status/) && !/ took /)) { if (++n <= 20) print }' || true
  echo "--- logcat crash buffer: what crashed (first 20) ---"
  "$ADB" -s "$ANDROID_SERIAL" logcat -b crash -d 2>/dev/null \
    | awk '/FATAL EXCEPTION|Process: |Fatal signal|Abort message|>>> / { if (++n <= 20) print }' || true
}

# Print the emulator log, and the framework's restart history while the device
# still answers, so a red job carries its own diagnosis.
ci_emulator_log_tail() {
  if [[ -f "$EMULATOR_LOG" ]]; then
    tail -200 "$EMULATOR_LOG"
  fi
  ci_emulator_framework_report
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
