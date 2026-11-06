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
| M2 | Toolbar and selection state (Mason's heading/format items), projection styling | done |
| M3 | Lists, checkboxes, quotes, code | done |
| M4 | Links and wikilinks, including completion | done |
| M5 | Images | done |
| M6 | Tables | done |
| M7 | Find | done |
| M8 | Long notes: quick open, streaming, Select All | |
| M9 | Remaining mobile lines and an evidence pass (incl. VoiceOver must read an image's alt text, not its hidden Markdown) | |

## Engine MRs and !564 notes

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `DisplayIndex.kt`, `DisplayMirror.kt` (UTF-16 to UTF-8 conversion of engine changes) | `futo_notes_editor::host::DisplayMirror`, `EditorDisplayMirror` | !589 | posted |

## Engine MRs and !564 notes (M2)

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `SpanPlan.kt` (`planSpans`, `splitAtLines`) | `host::plan_styles`, `NativeEditorSession.style_plan` | !592 (stacked on !589) | posted |
| `toolbarActive` / disabled-id mapping in `TextFirstToolbar.kt`, `EditorEngineCaret.kt` | `host::toolbar_highlights`, `NativeEditorSession.toolbar_highlights` | !594 (stacked on !592, merges !590 for `ToolbarState`) | posted |
| (no Kotlin: engine gap Android shares) caret Backspace/Delete next to an image removes the whole atom | `ParagraphKey::Backspace/Delete` widen to the atom | !595 (from main) | posted |
| `EditorEngineTables.kt` (`tableSpans`, lookup half of `publishCell`) | `host::plan_tables`, `EditorStyleSpan.TableRow/TableDelimiter`, `NativeEditorSession.cell_view` | !596 (stacked on !593) | to post |
| `SpanPlan.kt` image branch (`SpanSpec.Image`) | `host::StyleSpec::Image`, `EditorStyleSpan.Image` | !593 (stacked on !592, merges !590 for `is_http_image_source`) | posted |
| `EditorEngineFind.kt` (`snapshot`: UTF-16 marks, composition suppression, reveal target; `findStep`'s `landed` first-press rule) | `host::plan_find`, `host::FindLanding`, `NativeEditorSession.find_snapshot` / `find_step_landing`, `EditorFindLanding` | !598 (stacked on !589; cherry-picked here because this branch carries the older !589 commit) | posted |
| `ToolbarCommandGate.kt` | not needed on iOS: every command runs synchronously on the main actor, so none is queued or dropped. Revisit if M8 moves the engine off the main thread. | | |

## Decisions log (reversible)

- 2026-11-06, orchestrator: a table cell edits in place, not in a sheet. `TextFirstCellEditor` is a
  field (a subview of the note's text view, so it scrolls with it) laid over the tapped cell
  (160 pt column, row height, the grid's font and alignment), on the same engine session; its
  accessory bar has Undo and Done; Done, or a tap on the note outside it, returns. Reverse by
  presenting the same object in a sheet again (`openCellEditor`); spec line in mobile/tables.md.

## M7 notes

- Engine: the non-UI half of `EditorEngineFind.kt` is `host::plan_find` (report + matches to UTF-16
  marks, hidden while composing) and `host::FindLanding` (the first press after a query change
  lands on the current match; later ones step). Everything else (matching, wrap, table barriers,
  stale rescans, rebasing) was already the engine's.
- Entry and bar: an overflow menu (ellipsis) in the note screen's toolbar holds "Find in note" (the
  other actions of the WebView screen's menu are M9); the existing `FindInNoteBar` is a layout
  sibling under the editor, so it rides above the keyboard and the note never runs under it.
  Count text is the catalog's `editor.find.matchCount`.
- Marks: never in the text storage. `TextFirstLayoutFragment` paints them behind the glyphs (every
  paragraph is now a custom fragment: a fragment laid out before the first mark is not rebuilt by
  invalidation), inside table cells (cell text laid out as the grid draws it) and over an image
  whose alt text or destination matches (the engine counts those; the spelling is hidden). Orange =
  current, yellow = the rest. Repaint = invalidating the viewport's layout.
- Edits keep the bar open: `accept` schedules a 150 ms refresh (engine rebases on read; a stale
  report takes a scan request, scans on a background queue, applies if the revision still holds).
- Step: lands via the engine selection (`selectUtf16`), scrolls the match a third of the way down,
  and scrolls a table's columns to the match's cell. It does NOT open the cell field (Android does);
  the field opens on tap. Closing restores the selection and scroll position from before find opened
  when nothing was edited (find-in-note.md iOS/Android line; Android text-first does not).
- Spec: `docs/spec/editor/mobile/find.md` (one *(mobile)* line, one *(iOS)* line); Android's find
  line in portable-core/find.md kept only its cell-field-focus half (38cd5c444 on android-text-first).
- Tests: `TextFirstFindTests` (8: marks, stepping with wrap, refresh after edits, close, table
  cells and a column scroll, cell marks after an edit above, image marks, painted pixels) and
  `TextFirstFindUITests` (real touches: menu, bar above the keyboard, count, steps, close).
- Open: the engine counts a match in an image's file name, so a step can land on a hidden spelling (the picture is marked).

Milestone notes M1 to M6: [ios-text-first/notes-m1-m6.md](ios-text-first/notes-m1-m6.md).

## Human checklist (needs a physical iPhone; never blocks a milestone)

- Dictation (placeholders never reach the file), QuickPath swipe typing, Writing Tools rewrite and
  proofread, third-party keyboards, Apple Pencil Scribble.
- Toolbar behavior over the real keyboard on a phone, arrow-key caret affinity at format boundaries
  (hardware keyboard), VoiceOver reading headings.
- Camera capture, the photo picker, and pasting from Photos/Safari ("Copy Image") into a note; EXIF-rotated camera photos drawing upright; large photos (12 MP) loading without a hitch.
- Find bar over the real keyboard on a phone (height with the accessory row), stepping through a
  long note, and the in-place cell field with a hardware keyboard.
- Real-device keystroke timings at 20k lines (the simulator numbers are not phone numbers).
