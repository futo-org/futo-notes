# Verification speed

What made the agent verification chain slow, measured, and why each fix is safe.
Command authority is still the justfile; `justfile-notes.md` holds the other per-recipe rationale.

## test-android-native (bindings only, both flavors)

The JVM unit tests never load `libfuto_notes_ffi`: they read the generated Kotlin bindings and
nothing else of the Rust build. So the recipe depends on `_android-bindings`
(`ABIS=none bash scripts/build-rust-android.sh`: host library + bindgen, no `cargo ndk`)
instead of the three-ABI `release-ffi` build, which was ~120s of every call after a Rust change
(~130s down to ~8s). `none` also skips the NDK and cargo-ndk lookups, and still empties
`jniLibs/` first, so a later bare `./gradlew` install cannot carry a stale `.so`.
`build-android-native`, `test-android-native-ui` and every install recipe still build the ABIs.

Both flavors keep running: the only flavor-dependent code is `BuildConfig.IS_PLAY_BUILD` /
`LICENSE_DISTRIBUTION` (read by `LicenseModel.kt`, observed by `DistributionFlavorTest` and
`LicenseDistributionTest`), but the whole `play` pass costs ~1s warm (490 tests run in under 1s;
Kotlin compile is incremental), so narrowing it would save nothing and could miss the next
flavor-dependent test.

## Cargo thrash between package selections

Cargo unifies features across the packages named by `-p`, so `cargo test -p A -p B`, `cargo build
-p B --example x`, `cargo build -p ffi --features bindgen` and the Tauri contract test each resolve
`serde`, `smallvec` (via `ropey`) and `serde_json` differently. The workspace crates keep one metadata
hash across those resolutions, so each switch dirties `futo-notes-editor` ("info of dependency
`ropey` changed") and rebuilds editor, store and ffi (5-12s). It is not a bug in any one recipe:
`cargo build -v ... | grep Dirty` names the cause. Feature-pinning on editor's dependencies or a
workspace-hack crate would remove it; neither is in place, so keep consecutive Rust commands on
one selection where you can (the docs name `-p futo-notes-editor -p futo-notes-store -p
futo-notes-core`, `just test-rust` adds `-p futo-notes-merge`).

## Looked at and left alone

- **`test:full` and `just test-editor-wasm` do not rebuild the WASM or the host on every call.**
  vitest compiles nothing. The wasm script runs `cargo build` for the wasm target (a no-op when
  fresh, 0.1s) and for the host `portable_host` example, then wasm-bindgen (0.3s) and thirteen
  node consumers (~4s). Its 17-25s came from the cargo thrash above: the example build re-resolves
  features and rebuilds editor+store (~12s) after any other cargo command, and the next cargo
  command rebuilds them back.
- **vitest** is ~48s for 374 files on 4 workers: ~21s of tests and ~14s spawning 374 isolated
  workers. `--no-isolate` and `--pool=threads` were tried or are suggested by vitest itself;
  threads fails 69 tests and no-isolate trades test independence for speed, so neither is a
  tooling-only change. The worker cap (`UNIT_TEST_MAX_WORKERS`) is deliberate.
- **Both Android flavors** run for the JVM tests: the play pass costs ~1s warm.
- **The three-ABI `release-ffi` build** (~124s warm after a Rust change, serial per ABI under
  one target-dir lock) is what `build-android-native` verifies; a cheaper profile or one ABI
  would stop checking what CI builds. Per-ABI target dirs could run them concurrently but
  recompile the host-side build scripts three times.
