# FUTO Notes — native Android shell

A from-scratch **native Jetpack Compose** app that is the Android sibling of
`apps/ios`. It reuses, unchanged:

- **The same Rust core** — `futo-notes-ffi` (note CRUD + rules + E2EE sync),
  built per-ABI into `jniLibs/<abi>/libfuto_notes_ffi.so` with UniFFI **Kotlin**
  bindings. The exact same crate iOS builds into an xcframework with Swift
  bindings.
- **The same web editor** — the single `editor.html` bundle, loaded into a
  `WebView` and driven through the identical `futoBridge` contract
  (`@futo-notes/editor` / `packages/editor/src/bridge.ts`).

So the note business logic lives in Rust once; Compose (here) and SwiftUI
(iOS) are presentation only.

## Layout

```
apps/android/
├── settings.gradle.kts / build.gradle.kts / gradle.properties
└── app/
    ├── build.gradle.kts            # Compose + JNA (for UniFFI) + coroutines
    └── src/
        ├── main/
        │   ├── AndroidManifest.xml
        │   ├── assets/editor.html      # staged from the editor build (gitignored)
        │   ├── jniLibs/<abi>/*.so      # staged by build-rust-android.sh (gitignored)
        │   ├── res/                    # fonts, launcher icons; strings are GENERATED
        │   └── java/
        │       ├── com/futo/notes/
        │       │   ├── MainActivity.kt
        │       │   ├── NotesStore.kt         # reactive shell over the Rust NoteStore
        │       │   ├── SyncManager.kt        # reactive shell over the Rust SyncClient
        │       │   ├── localization/         # catalog runtime (shared fixture-locked)
        │       │   ├── storage/              # storage location + vault migration
        │       │   └── ui/                   # screens, EditorWebView, components/, navigation/, theme/
        │       └── uniffi/futo_notes_ffi/futo_notes_ffi.kt  # generated (gitignored)
        ├── debug/                  # debug-only surfaces (testhook/)
        ├── release/                # no-op stand-ins for the debug-only surfaces
        └── test/                   # JVM unit tests
```

The screens (`NoteListScreen`, `NoteEditorScreen`, `SearchScreen`,
`SettingsScreen`, `SyncScreen`, `StorageOnboarding`) mirror the iOS app's views.
`EditorWebView.kt` is the Android counterpart of the iOS `EditorWebView.swift`;
the bridge messages both hosts handle are listed in the generated
`ui/BridgeSpec.kt` (source of truth: `packages/editor/src/bridge.ts`).

## Build & run

```bash
apps/android/run.sh        # build Rust core + editor + Gradle install + launch
# or step-by-step:
scripts/build-rust-android.sh                      # .so + Kotlin bindings
pnpm exec vite build --config vite.editor.config.ts # editor.html
# (copy editor.html into app/src/main/assets/, then `gradle :app:installDebug`)
```

### Prerequisites

- **Android SDK** (`ANDROID_HOME`) + a recent Android Gradle Plugin toolchain.
- **JDK 17** — required by the Android Gradle Plugin.
- **Android NDK** (`ANDROID_NDK_HOME`) — `scripts/build-rust-android.sh` checks
  for it early and errors with install instructions if missing.
- `cargo install cargo-ndk` + the android rust targets:
  `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`.

> Verified independently of the NDK/SDK: `futo-notes-ffi` builds as a `cdylib`
> and `uniffi-bindgen --language kotlin` generates the bindings the app imports.
> Full device build/run requires the Android toolchain above.

## Device notes

- **Gradle wrapper is committed** and pinned to 8.14.3 (`gradle/wrapper/gradle-wrapper.properties`).
  Use `./gradlew`; don't run `gradle wrapper`, it would overwrite the pin.
- **Empty-editor soft keyboard.** Android `WebView` can refuse to raise the keyboard for an empty
  `contenteditable`; `EditorWebView.kt`'s `focusEditor()` does the JS focus and then the native
  half (`requestFocus()` + `showKeyboardWhenServed`), because CM6 DOM focus alone does not bind
  the IME to the WebView.
- **`usesCleartextTraffic=true` in all build types** (deliberate) so self-hosters can sync to a
  plain `http://` server; note content is E2EE before upload, so cleartext carries only encrypted
  blobs + auth. HTTPS is still recommended.
- **`applicationId`**: release `com.futo.notes`, debug appends `.dev`, so dev installs keep separate
  app data.
