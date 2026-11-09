# Android text-first handoff: Architecture

[← handoff index](README.md)

## 2. Architecture

```text
real keyboard / toolbar / camera / paste
  → EngineInputConnection (editor thread)
  → Rust NativeEditorSession (UniFFI over JNA; hot keys over plain JNI)   ← every Markdown rule
  → view-change windows + span/table inspection
  → TextFirstEditText (ChunkedEditable, NoteScroll fling)
```

**Rust owns the bytes and every Markdown rule. Kotlin owns only the view.**
`crates/futo-notes-editor` handles parsing, projection to display text, every edit and command,
undo history and toolbar eligibility. `crates/futo-notes-store` handles the note's session,
debounced saves (500 ms idle, 2 s max), merges and renames. `crates/futo-notes-ffi` holds the
UniFFI bindings. The Android view holds display text with no Markdown markers. An input
filter refuses any edit that did not come from the engine. Coordinates are display UTF-16 on
the Kotlin side and display UTF-8 bytes on the engine side, converted at the edge. A
behavior question is a Rust question unless it is about drawing, touch or IME mechanics
(ADR-0011, `docs/plan/text-first-editor-rebuild.md`).

### Key Kotlin classes (`textfirst/` unless noted)

| Class / file | What it does |
|---|---|
| `TextFirstEditorScreen.kt` | The note screen when the flag is on. Title and rename, leave/save, the sync-summary hookup (`store.localTreeChanges` → `reconcileExternalChanges()`, or close on a remote delete). |
| `TextFirstController.kt` | One open note: the view, its engine and the Compose-facing state (caret, find, cell). UI thread only. |
| `EditorEngine.kt` (+ `EditorEngine*.kt` extensions) | The editor thread. Owns `NativeEditorSession` (FFI calls block, so never on the UI thread) and applies each accepted change to its own copy of the display text before posting it to the view in order. The extensions split it by concern: `Caret`, `Find`, `Tables`, `Images`, `Links`, `Keyboard`, `Opening`, `Storage`, `Stream`, `Updates`, `Recovery`, `Completion`, `Window`. |
| `EngineInputConnection.kt` | The IME connection, dispatched on the editor thread (Chromium's threaded-input arrangement). Reads come from the mirror; writes go to the engine. |
| `DisplayMirror.kt`, `DisplayIndex.kt` | The editor thread's copy of the display text plus the UTF-16 ⇄ UTF-8 index (Fenwick trees per line). |
| `TextFirstEditText.kt` (+ `TextFirstEditText*.kt`) | The platform `EditText`. It never edits itself; updates arrive as `UiUpdate`s. The extensions cover styling, reveal, selection drawing, scroll, width changes, find marks, images, release. |
| `ChunkedEditable.kt`, `EditableChunk.kt` | The `Editable`, split into chunks of whole lines so a keystroke's cost doesn't grow with the note (`SpannableStringBuilder` was over 150 ms a key on the Moto at 19k lines). |
| `SpanPlan.kt`, `TextFirstSpans.kt`, `TfSpanFactory.kt` | Engine projection → per-line span specs → Android spans: headings, emphasis, list markers, quote bars, code, the look matched to Milkdown. |
| `RenderWork.kt`, `EditableRendererUpdate.kt`, `TextFirstRenderHold.kt` | Background style/stream slices, acknowledged one at a time. They hold while a finger or the text menu is up. |
| `EditorEngineStream.kt`, `EditorEngineStorage.kt`, `EditorEngineOpening.kt`, `TextFirstOpening.kt` | Quick open of the first 16 KB, streaming the rest, queuing taps and keys typed while the note is still opening. |
| `FastKeys.kt` | Per-key calls over plain JNI (`jni_keys.rs`) instead of JNA: about 2 ms a key cheaper on the Moto. |
| `ToolbarCommandGate.kt`, `TextFirstToolbar.kt`, `ui/EditorToolbar.kt` | Drops toolbar taps while a command runs. Maps toolbar ids to engine commands. The shared Compose toolbar. |
| `ViewEditJournal.kt` | Maps a touch selection made against an older view update onto the current text. |
| `NoteScroll.kt`, `LineSelectTouch.kt`, `ExternalLinkTouch.kt`, `WikilinkTouch.kt`, `ImageTouch.kt`, `TableGridTouch.kt`, `TextFirstCheckbox.kt` | Gesture owners: fling, triple-tap line select, link/wikilink/image/checkbox taps, horizontal table scroll. |
| `EditorEngineTables.kt`, `TextFirstTableSpans.kt`, `TextFirstTableCellHost.kt`, `TableCellEditText.kt`, `TextFirstTableGeometry.kt` | The table grid and the in-place cell field (same session, same window). |
| `EditorEngineFind.kt`, `FindMarks.kt`, `TextFirstFind.kt`, `ui/NoteEditorFindBar.kt` | Find. |
| `TextFirstImages.kt`, `ImageLoader.kt`, `TextFirstClipboard.kt`, `../ImagePicker.kt` | Image claims (picker, camera, paste), decoding (Coil for remote images, no persistent cache) and the clipboard. |
| `../storage/StorageMigrationGate.kt`, `../LocalTreeProjection.kt` | Serialize editor I/O against storage migration. Project the store's sync summaries for the open note. |
| `app/src/debug/.../puppet/PuppetNativeEditorState.kt` | Read-only puppet view of the native editor state (text, spans, selection). |

`NativeEditor*Test` classes under `androidTest/.../editor/` are the FFI contract tests (they
run on main as well). `textfirst/*Test` classes test the view.

**Merging and sync.** The Rust store applies remote merges and renames itself (shipped through
!574–!578 and !583). Kotlin only reacts to `LocalTreeSummary`
(`TextFirstEditorScreen.kt` around line 242). The editor reconciles through the same
attachment, so selection and local history survive. A two-device run passed for #325.

### Android-only Rust (still on this branch, not on main)

- `crates/futo-notes-ffi/src/editor/jni_keys.rs`: plain JNI entry points for the per-key
  calls. They return UniFFI's own byte encoding, so Kotlin decodes with the generated
  converters. Key codes match `FastKeys.kt` (e.g. Tab = 4, Shift+Tab = 5). Compiled only for
  `target_os = "android"` or tests (`editor/mod.rs`).
- The `jni = "0.21"` dev-dependency in `crates/futo-notes-ffi/Cargo.toml`.
- `crates/futo-puppet` tweaks: native row text keeps runs of spaces, plus gesture-argument and
  target changes.

### Where the engine went, and how to change engine code

On 2026-11-08 every engine, store and FFI change that had built up on this branch landed on
main as **!590** (`abaa6f9e1`). Since then `crates/` on this branch differs from main only by
the Android-only pieces above (MR !564 note, 2026-11-08). The later engine MRs (!593–!604,
!627–!632) reached the branch through ordinary merges of main.

**Never change engine code on this branch.** To fix a Markdown rule:

1. Cut a branch from `origin/main` (convention: `engine/<topic>`). Write the failing test in
   `crates/futo-notes-editor/tests/` and fix it. Update the `docs/spec/editor/portable-core/`
   line.
2. Gate: `cargo test -p futo-notes-editor -p futo-notes-ffi -p futo-notes-store`,
   `just test-editor-wasm`, `just test-rust`. Read `crates/futo-notes-editor/AGENTS.md`.
3. Open a small MR to main. Post a one-line note on !564 if Android benefits or must react.
4. After it merges, merge main into `android-text-first`.

