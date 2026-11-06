# iOS text-first editor — milestone ledger

Goal: the native iPhone editor reaches the level of the Android text-first editor
(`android-text-first`, MR !564). Dev builds only, behind a persistent flag. Delete this file in the
commit that finishes the last milestone (archive rule).

## Decisions (final)

- A TextKit 2 `UITextView` holding display text only (no Markdown markers), driven by the Rust
  engine (`futo-notes-editor` + `futo-notes-store` over `futo-notes-ffi`), which owns the note's
  exact bytes, history, saving and every Markdown rule. No Markdown rules in Swift.
- Deployment floor stays iOS 18; iOS 27 TextKit APIs are gated behind `#available`.
- Flag: `TextFirstFlag` (`futo.textFirstEditor` in `UserDefaults`), dev builds only, persisted from
  the launch argument `-futo.textFirstEditor YES|NO`, off by default. When on, `EditorHost.shared`
  (and so the WKWebView) is never touched (`EditorHost.isInUse`).
- Logic that exists only in Kotlin and is not platform UI is written in Rust (`host` module of
  `futo-notes-editor`, UniFFI in `crates/futo-notes-ffi/src/editor/host.rs`) via small engine MRs
  cut from `origin/main`, each noted on !564.
- Spec: an *(Android text-first editor)* line that is not Android-specific moves to
  `docs/spec/editor/mobile/` retagged *(mobile)* in the commit that makes it pass on iOS, and is
  cherry-picked onto `android-text-first`.

## Milestones

| # | Scope | State |
|---|---|---|
| M1 | Port the proof onto the current engine: open, type, save, IME shapes, kill loop, 20k smoke | done |
| M2 | Toolbar and selection state (Mason's heading/format items) | |
| M3 | Lists, checkboxes, quotes, code | |
| M4 | Links and wikilinks, including completion | |
| M5 | Images | |
| M6 | Tables | |
| M7 | Find | |
| M8 | Long notes: quick open, streaming, Select All | |
| M9 | Remaining mobile lines and an evidence pass | |

## Engine MRs and !564 notes

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `DisplayIndex.kt`, `DisplayMirror.kt` (UTF-16 to UTF-8 conversion of engine changes) | `futo_notes_editor::host::DisplayMirror`, `EditorDisplayMirror` | !589 | posted |

## M1 notes

Architecture as built: `TextFirstNoteScreen` (native title field + editor) replaces `NoteEditorView`
when the flag is on. `TextFirstEditorController` owns the `NativeEditorSession`, the
`EditorDisplayMirror` and the view; it reports each platform edit through the seam its shape needs
(typing, text-service replacement incl. dictation placeholders, marked-text composition) and
repaints only where the engine's answer differs from what UIKit already did. Saving is the Store's
debounce (500 ms idle, 2 s max wait) plus a checkpoint on `willResignActive` and a detach on leave.
There is no recovery log: a kill can lose at most the last save window, never tear the file.

Evidence (iOS 27.2 simulator `futo-qa-6`, Debug app, dev-profile Rust unless stated):

- Input-shape suite (`TextFirstInputShapeTests`, 38 rows x delegate-asked and bare UITextInput calls,
  each against a plain `UITextView` control): `just test-ios-native TextFirstInputShapeTests` passes.
  Japanese/Korean marked text, autocorrect, dictation placeholders (U+FFFC never reaches the
  source), smart punctuation off. Two row expectations moved with the engine, not the host: typing
  at a link's end lands inside the link text (default backward affinity), and a typed `|---|` table
  stays rows of text in display (the table is M6's widget).
- Kill loop (`TextFirstKillLoopTests`, UITest): 10/10. Each run types a digit every 100 ms for
  10 s, then SIGKILL of the app's pid. The file the kill left was always the note plus a prefix of
  the keys, 11-13 keys (about 1.2 s, inside the 2 s max-wait window) not yet saved, and the
  reopened editor showed exactly the file. `just test-ios-native-ui TextFirstKillLoopTests`
  (`TEST_RUNNER_TF_DIR` names a host directory for the log and vault).

- 20k-line smoke (`TextFirstSmokeTests`, opt-in; release-ffi Rust, Debug app, simulator): 20,000
  lines / 898,889 bytes, `openEditor` + first display 61 ms, first layout 92 ms, 300 keystrokes in
  the middle of the note p50 1.5 ms, p95 1.8 ms, max 13.2 ms (delegate round trip, engine, repaint
  and a layout pass). Recorded, not a gate. Command in the test's header. Dev-profile Rust is far
  slower and is not a measurement.
- Engine finding (not fixed here): a 20k-line note with ~2,500 separate one-item ordered lists
  (`1. ordered N` between other blocks) takes 3-8 s per keystroke in the middle, release build
  (`inline::spelling::spell_with_anchors` via `Projection::edit_in`); the same note without them
  takes under 100 us, and a note of 20k plain paragraphs 35-265 us. Needs an engine ticket (M3/M8).
- Visual check: with the flag on, `just puppet` reaches the list and the opened note shows display
  text with no markers (no styling yet). Puppet has no native-editor reads, so typing is covered by
  the unit and UI tests.
- Pre-existing failures on the base (`engine/from-android-text-first`, from `b876e63b3` "end every
  authored note write in a line ending"): 9 tests / 20 issues in `FlushDraftVerbTests`,
  `NativeEditorContractSurfaceTests`, `NativeEditorSessionTests`, `RetainedEditorDraftTests` expect
  bytes without the final line ending. Untouched here; all 20 text-first tests pass.
- Spec: the *(Android text-first editor)* system-text-actions line moved to
  `docs/spec/editor/mobile/clipboard.md` as *(mobile)* (unit-tested on iOS), cherry-picked as
  4fedf5ac5 on `android-text-first`.

Deferred inside M1 (by design): no Markdown styling (M2/M3), no toolbar (M2), engine calls on the
main thread (typing) with saves on a serial queue (M8 revisits), no quick open or queued input
before the session exists (the text view appears when the session is attached; M8).

## Human checklist (needs a physical iPhone; never blocks a milestone)

- Dictation (placeholders never reach the file), QuickPath swipe typing, Writing Tools rewrite and
  proofread, third-party keyboards, Apple Pencil Scribble.
- Real-device keystroke timings at 20k lines (the simulator numbers are not phone numbers).
