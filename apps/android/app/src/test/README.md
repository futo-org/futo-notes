# Android JVM unit tests

Pure-logic tests for the native Android shell (no device/emulator): the
editor-session draft/flush lifecycle, IME-dismiss blur transition, bridge
message coverage, and sync-manager defaults. Instrumented tests (which need a
device and wipe app data on teardown) do NOT live here.

Run locally from the monorepo root:

```bash
just test-android-native   # builds the UniFFI Kotlin bindings, then gradlew testDebugUnitTest
```

CI: `build:android-native` runs `:app:testDebugUnitTest` on BOTH its paths —
merge-request/default-branch builds and tag/release builds — so a red unit
test blocks publishing. JUnit results are uploaded as a GitLab test report
(visible in the MR widget even on failure), and the job fails red if zero
tests execute.
