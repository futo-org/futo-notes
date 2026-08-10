# apps/android — native Compose shell

Read the root `AGENTS.md` first; this adds the rules specific to this layer.

The shipping Android app: a Jetpack Compose shell over the shared Rust core
(`futo-notes-ffi`, UniFFI Kotlin bindings) with the web editor embedded in a
WebView. There is no Tauri Android shell.

```bash
just android-native            # Rust ffi (all ABIs) → editor bundle → installDebug → launch
just build-android-native      # compile-only sanity
just test-android-native       # JVM unit tests (the only Android tests CI runs)
just test-android-native-ui    # Compose instrumentation tests on $ANDROID_SERIAL
just android-drive             # drive the running app; no args prints the commands
just test-android-storage      # user-level storage stories on a real device
```

For app-only Kotlin iteration, `./gradlew :app:installDebug` from here is enough.
After changing `futo-notes-ffi` or a crate it re-exports, rebuild the bindings
first (`just build-rust-android`) or you are testing yesterday's Rust (M9) — the
symptom is "my change did nothing" or a Kotlin compile error on a missing symbol.
The `just *-native` recipes rebuild for you; a direct gradle invocation does not.
The Android FFI build uses the `release-ffi` profile because the workspace
release profile's `panic = "abort"` breaks UniFFI's `catch_unwind` — never switch
it to plain release. `versionCode = MAJOR*1e6 + MINOR*1e3 + PATCH`.

## Source sets

| Set | Contents |
| --- | --- |
| `app/src/main` | the app |
| `app/src/debug` | debug-only surfaces — currently `testhook/` |
| `app/src/release` | no-op stand-ins for debug-only surfaces, at the same FQN |
| `app/src/test` | JVM unit tests; compiled against `main + debug` |

Generated and gitignored: `uniffi/` Kotlin bindings, `jniLibs/`,
`app/src/main/assets/editor.html`. Never edit them — regenerate (M8).
`ToolbarSpec.kt` and `TitleSpec.kt` are likewise generated, from
`packages/editor/src/toolbar.ts` and `filename.ts`: edit the manifest, then run
`just toolbar-spec` / `just title-spec`.

## Constraints

- **CRITICAL — dev/prod data split (M3).** Debug builds use the `.dev`
  application id, which isolates APP/INTERNAL storage; DEVICE mode uses
  `FUTO Notes Dev` instead of prod's `FUTO Notes`, gated by `BuildConfig.DEBUG`.
  Never weaken this — a debug build must never touch real notes.
- **`app/src/main/java/com/futo/notes/storage/NotesStorage.kt` holds one of three
  independent copies of the default notes-root split** (Rust `vault_location.rs`
  and iOS `NotesStore.swift` are the others; registry entry
  `notes-root-triplet`). Touch one, touch all, in one commit.
- **I/O belongs on `Dispatchers.IO`**, and `hasBootstrapped` distinguishes
  loading from empty so the shell renders immediately (M1). Never await work
  before first render.
- A new `futoBridge` message needs a hand-written host in
  `app/src/main/java/com/futo/notes/ui/EditorWebView.kt` **and** its iOS
  counterpart — `packages/editor/src/bridge.ts` is the source of truth (M10).

## Testable logic goes down, not sideways

There is no instrumented-test target in `check`/CI here, and the storage-switch
success path ends in `Runtime.getRuntime().exit(0)`, which an instrumentation
runner reports as a crash. So Kotlin has exactly two places to be verified:

1. **A JVM unit test** in `app/src/test/java/com/futo/notes/`, for anything that
   can be a pure function over plain data.
   `app/src/main/java/com/futo/notes/storage/StorageSwitchPlan.kt` and its
   `StorageAdoptionMessage.kt` sibling are the pattern: the decision and the
   wording are pure and tested; only the effects stay in `MainActivity`.
   `SyncManagerDefaultsTest.kt` reads the full shared `validateServerUrl`
   fixture — it is a lock, not a sample.
2. **A device-level harness** in `tests/android-*.mjs`, for whole user stories.

Anything that could be either belongs in (1). Prefer pushing a rule into the Rust
crates over writing it in Kotlin at all (root §4) — one definition, three
consumers.

## Debug-only automation hooks

`app/src/debug/java/com/futo/notes/testhook/` registers a broadcast-driven command
surface: the Android counterpart of the desktop `window.__testSync` hook. It
exists because an accessibility dump costs ~2s and shows what Compose last
managed to render, not what the app holds (M21) — so a test that taps through a
multi-step flow is both slow and unreliable.

Adding a hook is a few lines in `MainActivity.testHooks()`:

```kotlin
"confirm-storage" to {
    val adoption = checkNotNull(pendingStorageAdoption.value) {
        "no storage switch is awaiting confirmation"
    }
    pendingStorageAdoption.value = null
    adoptExistingStorage(adoption)
    null            // or a Map<String, Any?> of fields to report back
}
```

Rules:

- **A hook calls an entry point the UI already calls.** It must not contain
  behavior of its own, or the test stops testing the app.
- **Throw on a bad argument.** The ack carries the reason; a silent no-op looks
  exactly like a hung flow.
- **Return fields rather than logging them.** They travel back on the ack line,
  which is what makes one round-trip enough.
- **Never widen `main` to serve a hook.** If a hook needs state, it reads it in
  `MainActivity`, where it already lives.
- **Debug source set only.** A release build compiles the no-op sibling, so the
  release APK carries none of this — do not "simplify" that back into a
  `BuildConfig.DEBUG` branch in `main`, which would leave a shell-reachable way to
  move the user's notes in the shipped source and rely on R8 to drop it. The two
  `TestHooks` signatures must match; a mismatch fails the release compile, which
  is when you want to hear about it.

The `state` hook's field names are read by `tests/lib/android/testHooks.mjs`
(`STATE_FIELDS`) with nothing linking them at compile time. That is deliberate —
adding a field to `main` for a test-only type would be worse — and it fails loud:
`parseStateAck` throws naming any field that went missing. Change one side, change
the other.

## Traps specific to this shell

- **Programmatic-looking input lies.** An unfocused emulator throttles Compose
  frames, so `adb screencap` can show stale UI; verify via disk, logcat, or the
  `state` hook (M21). A programmatic DOM `click()` inside the editor WebView does
  not fire Svelte 5 handlers — tap at CSS-rect-center × devicePixelRatio with
  `adb input tap`.
- **Dialogs and menus render in separate windows**, so a node can be absent from
  a dump taken too early.
- **`run-as … ls files` hides dotfiles**, including the storage-migration journal
  (`files/.storage-migration`). It outranks the stored preference at startup, so a
  storage switch that reverts itself is usually a stale journal — `ls -a`.
- **`am broadcast` succeeds whether or not anything received it**, which is why
  every hook call waits for the app's own ack.
- **Legacy WebViews are version-bound, not OS-bound.** The System WebView updates
  independently of Android, so editor rendering bugs track Chromium versions
  (github#8); minSdk 28.
- **A WebView `versionName` is not a Chromium version.** Only Google's WebView
  numbers itself with Chromium; a vendor provider uses its own scheme (Huawei
  WebView 12.x/15.x on a modern Chromium), so comparing it against a Chromium
  floor rejects working engines — it locked a Huawei P Smart 2021 out of the
  editor with "needs 80 or newer. This device has version 15". Engine support is
  therefore decided by capability (`editor.html`'s preflight +
  `EditorEngineSupport.kt`), and the only version number that travels across
  providers is the UA's `Chrome/<major>`, which is wording, not a gate.

## Driving it under QA

Emulator/device QA of the changed flow is required. Respect `$ANDROID_SERIAL`
(from `just qa-claim android`) and never touch a device you did not claim; the
full playbook is the `/verify` skill's `references/android.md`.

`just emu-logs` gives tag-scoped logcat. For the editor WebView, `just cdp-forward`
then `node scripts/cdp-invoke.mjs "document.title"` — debug builds only, and
re-run the forward after every app restart because the WebView pid changes. The
emulator reaches host services (a local sync server) via `10.0.2.2`.
