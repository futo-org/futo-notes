# AGENTS.md — Native Android App

Native Compose app on the shared Rust core (`futo-notes-ffi`) with an embedded web editor. This is
the **shipping** Android app — there is no Tauri mobile shell. See @README.md for structure and
root AGENTS.md for cross-layer rules.

The UniFFI Kotlin bindings (`uniffi/`) and `jniLibs` are generated and gitignored. Edit the FFI
crate and regenerate; never edit the output.

## Building and running

| Goal | Command |
| --- | --- |
| Device or emulator | `just android-native` |
| Compile-only sanity | `just build-android-native` |
| JVM unit tests | `just test-android-native` |
| Compose instrumentation tests | `just test-android-native-ui` |

After **any** change to `futo-notes-ffi` or a crate it re-exports, run `just build-rust-android`
before building — otherwise you are testing old bindings, and the symptom looks like "my change did
nothing" or a Kotlin compile error on a missing symbol. The `just *-native` recipes do this for you;
a direct gradle invocation does not. The Android FFI build uses the `release-ffi` profile because
the workspace release profile's `panic = "abort"` breaks UniFFI's `catch_unwind` — never switch it
to the plain release profile.

`versionCode = MAJOR*1e6 + MINOR*1e3 + PATCH`.

## Constraints

- **CRITICAL — dev/prod data split.** Debug builds use the `.dev` application ID, which isolates
  APP/INTERNAL storage; DEVICE mode uses `FUTO Notes Dev` instead of prod's `FUTO Notes`, gated by
  `BuildConfig.DEBUG`. Never weaken this; a debug build must never touch real notes.
- **Push testable logic down into the Rust crates rather than Kotlin.** Kotlin should orbit the FFI
  facade, not reimplement note rules — a rule that exists in both WILL drift (root AGENTS.md §12).
- **`apps/android/app/src/main/java/com/futo/notes/storage/NotesStorage.kt` holds one of three
  independent copies of the default notes-root split**
  (Rust `vault_location.rs`, iOS `NotesStore.swift` are the others). Touch one, touch all.
- **I/O belongs on `Dispatchers.IO`**, and `hasBootstrapped` distinguishes loading from empty so the
  shell renders immediately. Never await work before first render.
- **`ToolbarSpec.kt` and `TitleSpec.kt` are generated** from `packages/editor/src/toolbar.ts` and
  `filename.ts`. Edit the manifest and run `just toolbar-spec` / `just title-spec`.
- A new `futoBridge` message needs a hand-written host in `EditorWebView.kt` **and** its iOS
  counterpart — the contract in `packages/editor/src/bridge.ts` is the source of truth.

## Testing and QA

New pure-logic seams get a JUnit test in `apps/android/app/src/test/java/com/futo/notes/`, run by
`just test-android-native` (CI runs these on MR, default, and tag pipelines).
`SyncManagerDefaultsTest.kt` reads the full shared `validateServerUrl` fixture — it is a lock, not
a sample.

Emulator/device QA of the changed flow is required. Respect `$ANDROID_SERIAL` (from
`just qa-claim android`) and never touch devices you didn't claim. The full playbook is the
`/verify` skill's `references/android.md`.

Two traps that will lie to you:

- **Programmatic DOM `click()` does not fire Svelte 5 handlers.** Tap at CSS-rect-center ×
  devicePixelRatio via `adb input tap`.
- **An unfocused emulator throttles Compose frames**, so `adb screencap` shows stale UI. Verify via
  disk or logcat, or force a real scroll.

`just emu-logs` gives tag-scoped logcat. For the editor WebView, `just cdp-forward` then
`node scripts/cdp-invoke.mjs "document.title"` — debug builds only, and re-run the forward after
every app restart because the WebView pid changes. The emulator reaches host services via
`10.0.2.2`.
