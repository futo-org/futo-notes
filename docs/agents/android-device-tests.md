# Android device tests

```bash
eval "$(just qa-claim android)"          # your emulator; ANDROID_SERIAL + ANDROID_AVD_NAME
just test-android-ui com.futo.notes.textfirst com.futo.notes.editor   # two packages
just qa-claim android --extra             # one more emulator (max 3 per worktree; the pool is shared)
just test-android-ui --shard              # the whole suite, split over every emulator you claimed
just test-android-ui --arg chunkRounds=5 com.futo.notes.textfirst.ChunkedEditableTest
just test-android-ui --rebuild …          # force the build even if nothing changed
```

`test-android-ui` is the device-test loop; `test-android-native-ui` is the full Gradle
path (`:app:connectedDirectDebugAndroidTest`) kept for CI parity and JUnit XML. Both run
only on emulators this worktree claimed: instrumentation clears the dev app's data, so a
physical phone is refused even when claimed with `--serial`.

`test-android-ui` builds the app and test APKs for the emulator's ABI only
(`-PfutoAbis=<abi>`, debug builds only — releases keep every ABI), then skips the build
outright on the next call if nothing changed: the key is HEAD, `git diff HEAD`, every
untracked file, the `FUTO_*`/`VITE_*`/`ABIS`/`VERSION_*` environment, the ABI and both
APKs' hashes, so another recipe rebuilding the APK also forces a rebuild. `--rebuild`
forces one. `scripts/android-instrument.mjs` then installs only an APK whose SHA-256
differs from the device's, clears the app's data (a Gradle run starts from a fresh
install), and runs every selector in one `am instrument -w -r`. It leaves the app
installed, so `just puppet relaunch` still works afterwards. It is red unless the run
finished, nothing failed or crashed, at least one test ran, and every selector ran at
least one test. Raw output lands in `apps/android/app/build/outputs/androidTest-results/instrument/`.

`--shard` splits the run across every emulator this worktree holds
(`just qa-claim android --extra` adds one, at most three per worktree, since lanes share
the pool) with `-e numShards N -e shardIndex i`, in parallel, and merges the results.
Extra claims are never `$ANDROID_SERIAL` and never what `just puppet` drives;
`just qa-release android` frees them with the first.

Why several classes used to run only the first: AGP 9 runs connected tests through its
built-in android-test-engine, which receives every runner argument in one system
property (`android-test.instrumentation-args=class=A,B`) and parses it by splitting on
`,` and then `=`, keeping only `key=value` pairs. The bare `B` was dropped and the task
passed. The Gradle recipe therefore sends several selectors as one single-quoted
`tests_regex` (no comma, no `=`), and checks the JUnit XML for every selector afterwards
— a shell error in the engine's unquoted command line also ran zero tests and passed.

The host `cargo build` in `build-rust-android.sh` / `build-rust-ios.sh` uses
`--features bindgen`, the same as the bindgen run after it. With different features each
command re-resolved `serde` and dirtied the other, so every call recompiled
editor, store and ffi twice (~45s warm).

Measured 2026-11-05 on futo-qa-5 (x86_64, warm): one class went from 60–90s per call to 10s;
the 243-test suite from ~69 min as one call per class to 296s in one call, or 107s
sharded over three emulators.
