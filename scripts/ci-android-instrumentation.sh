#!/usr/bin/env bash
set -euo pipefail

: "${CI_PROJECT_DIR:?CI_PROJECT_DIR is required}"

# Emulator lifecycle (boot flags, KVM detection, readiness wait) is shared with
# the cross-platform sync leg — see scripts/ci-android-emulator.sh.
# shellcheck source=scripts/ci-android-emulator.sh
source "$CI_PROJECT_DIR/scripts/ci-android-emulator.sh"

RESULTS_DIR="$CI_PROJECT_DIR/apps/android/app/build/outputs/androidTest-results/connected/debug"

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

# --wipe: this job owns the AVD and wants a pristine device each run.
ci_emulator_start --wipe

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
ci_emulator_stop
