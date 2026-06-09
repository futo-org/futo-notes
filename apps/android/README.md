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
    └── src/main/
        ├── AndroidManifest.xml
        ├── assets/editor.html      # staged from the editor build (gitignored)
        ├── jniLibs/<abi>/*.so      # staged by build-rust-android.sh (gitignored)
        └── java/
            ├── com/futo/notes/     # Compose UI + thin FFI shells
            │   ├── MainActivity.kt
            │   ├── NotesStore.kt    # reactive shell over the Rust NoteStore
            │   ├── SyncManager.kt   # reactive shell over the Rust SyncClient
            │   └── ui/{NoteListScreen,NoteEditorScreen,SyncScreen,EditorWebView}.kt
            └── uniffi/futo_notes_ffi/futo_notes_ffi.kt  # generated (gitignored)
```

The three Compose screens mirror the iOS `NoteListView`, `NoteEditorView`,
and `SyncView`. `EditorWebView.kt` is the Android counterpart of the iOS
`EditorWebView.swift` (same bridge messages: `ready` / `change` / `focus`).

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
- **Android NDK** (`ANDROID_NDK_HOME`) — `scripts/build-rust-android.sh` checks
  for it early and errors with install instructions if missing.
- `cargo install cargo-ndk` + the android rust targets:
  `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`.

> Verified independently of the NDK/SDK: `futo-notes-ffi` builds as a `cdylib`
> and `uniffi-bindgen --language kotlin` generates the bindings the app imports.
> Full device build/run requires the Android toolchain above.
