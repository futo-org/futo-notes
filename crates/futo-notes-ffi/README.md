# Native facade

`NoteStore.open_editor` opens an owning `NativeEditorSession`. Call it and its
methods on the native I/O worker: append acceptance performs blocking recovery
I/O before returning the view change. Swift and Kotlin contract consumers live
in `apps/ios/Tests/Editor/NativeEditorSessionTests.swift` and
`apps/android/app/src/androidTest/java/com/futo/notes/editor/NativeEditorSessionTest.kt`.
The shipping views do not select this engine yet.

Input uses `EditorUtf16Range` and a sequence of unsigned 16-bit code units;
transport must not repair unpaired surrogates before Rust validates them.
Returned `EditorByteRange` coordinates address UTF-8 display bytes;
`EditorSourceByteRange` addresses source bytes. Convert display ranges with the
revision-checked `display_to_utf16` query. Native code applies returned changes
and semantic descriptions without parsing markdown.

`recovery_status` distinguishes accepted and durable revisions. A successful
`flush_recovery` protects accepted edits against modeled power loss; `checkpoint`
performs the store's complete persist-or-park workflow and returns its mutation.
A `CheckpointCommitted` failure still carries that mutation. `detach` releases
the attachment and keeps accepted recovery available, without checkpointing.
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
