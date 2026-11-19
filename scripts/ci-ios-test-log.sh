#!/usr/bin/env bash
# The two halves of the iOS test task's log handling (ci/cirrus/ios-test.yml).
#
#   ci-ios-test-log.sh filter           stdin -> stdout, minus lines that only bury the outcome
#   ci-ios-test-log.sh verdict LOG      pass/fail from what xcodebuild REPORTED in LOG
#
# The task tees the whole xcodebuild output to a file (an artifact, and what the
# verdict reads) and shows the console only the filtered stream: under iOS 27 each
# keyboard the UI tests show logs ~15,000 `UIKBRenderingLog` lines, which took
# the job past GitLab's 4 MB log limit and cut off the outcome (pipeline 40319).
#
# Pass/fail never comes from xcodebuild's exit code (M11): it returns non-zero for
# the empty XCTest bundle's "Executed 0 tests" on some Xcode versions even when
# Swift Testing passed. Each bundle is checked by its own marker, so one bundle's
# tests can never stand in for the other's, and it can never go silently green.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UITESTS_DIR="${UITESTS_DIR:-$ROOT/apps/ios/UITests}"

# Lines with no test information: the keyboard renderer's per-key chatter.
NOISE='\[UIKBRenderingLog\]'

verdict() {
  local LOG="$1"
  # (1) Any genuine test/build failure marker -> red.
  if grep -Eq '\*\* TEST FAILED \*\*|Testing failed:|Failing tests:|Executed [0-9]+ tests?, with [1-9][0-9]* failures?|Test run with [0-9]+ tests?( in [0-9]+ suites?)? failed' "$LOG"; then
    echo "ERROR: xcodebuild reported test/build failures" >&2
    grep -E '✘|error:' "$LOG" | grep -Ev "$NOISE" | tail -20 >&2
    sed -n '/^Failing tests:/,$p' "$LOG" | head -30 >&2
    return 1
  fi
  # (2) The unit bundle: Swift Testing's own summary with >=1 test.
  #     FutoNotesNativeTests is the only Swift Testing bundle (UITests is
  #     XCTest), so this line is its count and nothing else's. Its XCTest half
  #     always prints "Executed 0 tests", and that line must never satisfy
  #     anything here.
  local UNIT_SUMMARY
  UNIT_SUMMARY="$(awk '/Test run with [1-9][0-9]* tests?( in [0-9]+ suites?)? passed/ { line = $0 } END { print line }' "$LOG")"
  if [ -z "$UNIT_SUMMARY" ]; then
    echo "ERROR: no passing Swift Testing summary with >=1 test from FutoNotesNativeTests" >&2
    grep -E 'Executed [0-9]+ tests?|Test run with [0-9]+ tests?' "$LOG" >&2 || echo "(no test summary at all)" >&2
    return 1
  fi
  echo "unit bundle: $UNIT_SUMMARY"
  # (3) The UI bundle: its XCTest suite passed with >=1 executed case.
  #     awk reads the whole log (no early-exit pipe, RC-65).
  local UI_EXECUTED
  UI_EXECUTED="$(awk '/Test Suite .FutoNotesNativeUITests\.xctest. passed/ { getline; if (match($0, /Executed [0-9]+ test/)) { n = substr($0, RSTART + 9, RLENGTH - 14) } } END { print n + 0 }' "$LOG")"
  if [ "$UI_EXECUTED" -lt 1 ]; then
    echo "ERROR: FutoNotesNativeUITests reported no passing suite with >=1 executed test" >&2
    return 1
  fi
  echo "UI bundle: $UI_EXECUTED test(s) executed"
  # Every UI suite must have passed, so a suite that silently never ran cannot
  # hide behind the bundle total.
  local SUITE
  for SUITE in $(sed -n 's/^final class \([A-Za-z0-9_]*\): XCTestCase.*/\1/p' "$UITESTS_DIR"/*.swift); do
    if ! grep -q "Test Suite '$SUITE' passed" "$LOG"; then
      echo "ERROR: UI suite $SUITE did not pass or did not run" >&2
      return 1
    fi
  done
  # (4) Require the overall success marker.
  if ! grep -q '\*\* TEST SUCCEEDED \*\*' "$LOG"; then
    echo "ERROR: no '** TEST SUCCEEDED **' marker in the test log" >&2
    return 1
  fi
  echo "iOS tests passed (arbiter: TEST SUCCEEDED + per-bundle test counts + no failure markers)"
}

case "${1:-}" in
  # grep exits 1 when it prints nothing; that is not an error here.
  filter) grep --line-buffered -Ev "$NOISE" || true ;;
  verdict)
    [ -n "${2:-}" ] || { echo "usage: $0 verdict LOG" >&2; exit 2; }
    [ -s "$2" ] || { echo "ERROR: $2 is missing or empty; xcodebuild wrote no log" >&2; exit 1; }
    verdict "$2"
    ;;
  *) echo "usage: $0 filter | verdict LOG" >&2; exit 2 ;;
esac
