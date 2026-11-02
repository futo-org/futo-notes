# Native facade

`NoteStore.open_editor` opens an owning `NativeEditorSession`. Call it and its
methods on the native I/O worker: input and saving take the
session's lock and may block on the store. Swift and Kotlin contract consumers live
in `apps/ios/Tests/Editor/NativeEditorSessionTests.swift` and
`apps/android/app/src/androidTest/java/com/futo/notes/editor/NativeEditorSessionTest.kt`.
The shipping views do not select this engine yet.

Input uses `EditorUtf16Range` and a sequence of unsigned 16-bit code units;
transport must not repair unpaired surrogates before Rust validates them.
Returned `EditorByteRange` coordinates address UTF-8 display bytes;
`EditorSourceByteRange` addresses source bytes. Convert display ranges with the
revision-checked `display_to_utf16` query. Native code applies returned changes
and semantic descriptions without parsing markdown.

`replace_utf16_action` forwards the engine's `Typing`, `Isolated` or
`CompositionCommit` history intent. Native marked text stays provisional until
one final commit; composition staging belongs to the following engine slice.
`replace_many_utf16` accepts all runs of one user action in opening-display
coordinates and validates every run before one accepted edit. Undo/Redo
restore the entire action's exact bytes, selection, affinity and carried formats.
`select_with_affinity`, `toggle_format` and `active_formats` expose that same
shared formatting contract without native policy. Reopening starts from the saved markdown with no persistent Undo/Redo history.

Edits live in memory and are saved as markdown 500 ms after the last edit (2 s max wait);
`save_delay` and `save_if_due` expose that schedule. `checkpoint` performs the store's
complete persist-or-park workflow and returns its mutation; a failed save does not pause
input. `detach` checkpoints, then releases the attachment; if the save fails the session
stays attached. There is no recovery log.
UniFFI's generated Kotlin `close`/`destroy` only releases object references.

The regular FFI, iOS and Android jobs collect the contract tests; these use the
existing release gate. Native verification regenerates bindings through the
`release-ffi` recipes:

```sh
cargo test -p futo-notes-ffi
FUTO_IOS_FFI_PROFILE=release-ffi just test-ios-native NativeEditorSessionTests
just build-rust-android
just test-android-native-ui com.futo.notes.editor.NativeEditorSessionTest
```

For an actual 32-bit Android acceptance run, provision an Android 29 `default;x86`
AVD named `futo-api29`, claim it with `just qa-claim android --avd futo-api29`, and
set its printed device environment. Build and run with
`ABIS=x86 just test-android-native-ui com.futo.notes.editor.NativeEditorSessionTest`.
Then require the native process width explicitly with the connected-test runner
(which installs the APKs again; Gradle removes them after a completed run):

```sh
apps/android/gradlew --project-dir apps/android \
  :app:connectedDirectDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.futo.notes.editor.NativeEditorSessionTest \
  -Pandroid.testInstrumentationRunnerArguments.editorRequire32Bit=true
```

The test fails in a 64-bit process when that argument is present, tests a range
beyond the 32-bit address space, and reports `EDITOR_NATIVE_CONTRACT_32BIT=true`.
A cross-compiled library alone is not execution evidence. `ABIS=x86` is a test
build override; release builds still require every shipped ABI.
