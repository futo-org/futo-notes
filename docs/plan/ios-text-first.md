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
| M6 | Tables | |
| M7 | Find | |
| M8 | Long notes: quick open, streaming, Select All | |
| M9 | Remaining mobile lines and an evidence pass | |

## Engine MRs and !564 notes

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `DisplayIndex.kt`, `DisplayMirror.kt` (UTF-16 to UTF-8 conversion of engine changes) | `futo_notes_editor::host::DisplayMirror`, `EditorDisplayMirror` | !589 | posted |

## Engine MRs and !564 notes (M2)

| Kotlin | Rust | MR | !564 note |
|---|---|---|---|
| `SpanPlan.kt` (`planSpans`, `splitAtLines`) | `host::plan_styles`, `NativeEditorSession.style_plan` | !592 (stacked on !589) | posted |
| `toolbarActive` / disabled-id mapping in `TextFirstToolbar.kt`, `EditorEngineCaret.kt` | `host::toolbar_highlights`, `NativeEditorSession.toolbar_highlights` | !594 (stacked on !592, merges !590 for `ToolbarState`) | posted |
| `SpanPlan.kt` image branch (`SpanSpec.Image`) | `host::StyleSpec::Image`, `EditorStyleSpan.Image` | !593 (stacked on !592, merges !590 for `is_http_image_source`) | posted |
| `ToolbarCommandGate.kt` | not needed on iOS: every command runs synchronously on the main actor, so none is queued or dropped. Revisit if M8 moves the engine off the main thread. | | |

## M2 notes

- `TextFirstStyler` draws the plan: heading sizes with weight, bold/italic/strike/code runs, quote
  indent and tint, code and front-matter mono, link and wikilink colour. The first 6k UTF-16 units
  are styled at once, the rest in 12k slices on the main queue; each accepted change restyles its
  own reparsed window (`change.projection.range`). Lists, checkboxes, dividers, quote bars: M3.
- Toolbar: the existing manifest view with the Text control hidden; lit/dimmed ids come from the
  engine (`toolbar_highlights`); taps are a name map onto `toggleFormat`/`blockCommandUtf16`
  (H1-H3 use `toggleHeading`, Code block `wrapCodeBlock`). Link, camera and image are inert until
  M4/M5. A collapsed Bold toggle also updates `typingAttributes` so the next character draws bold.
- Caret Backspace is sent as `backspaceJoiningHeading` (the engine falls back to plain Backspace).
- Not done: selection affinity from arrow keys (hardware keyboards), toolbar-over-IME timing on
  a device. Both are checklist items below.
- Spec: four *(Android text-first editor)* lines moved to `docs/spec/editor/mobile/toolbar.md` and
  `headings.md` (c2d60c043 on `android-text-first`). The heading-weight line stays Android's
  (it is about Barlow's semibold base).
- Visual check on the simulator (flag on, keyboard up): heading, bold, italic, code and quote draw,
  Undo/Redo dimmed on a fresh note.

## M3 notes

- Merged `origin/engine/from-android-text-first` (engine lane's final-newline test fixes plus four
  review fixes): full `just test-ios-native` = 320 tests, passed, 2 known issues (the typed-table
  row, both ways of asking). !590/the engine branch had not merged to main, so no retarget.
- Drawing: `TextFirstLayoutFragments.swift` ports the proof's fragments onto the engine's spans.
  `TextFirstStyler` puts one `TextFirstBlockAttribute` per line (quote depth, list row, code,
  divider) and head indents (quote + list depth); a layout delegate hands TextKit a fragment that
  draws bullets (disc/ring/square by depth), ordered numbers from the engine, checkboxes, quote
  bars, the code-block background and the divider rule. None are characters in the text.
- A row's later lines (a loose list's blank line) arrive with `first == false` and draw no marker.
- Checkbox tap: a tap recogniser hit-tests the fragment's checkbox (12 pt margin), calls
  `blockCommandUtf16(.toggleTask)` at the line, and restores the caret the tap moved. Verified on
  the simulator with a real tap (Undo lit afterwards). The keyboard still rises, as for any tap
  on the text view.
- Tab / Shift-Tab (hardware keyboard): `paragraphKey(.tab/.shiftTab)`; UIKit keeps the key when the
  engine changes nothing. The toolbar's Indent/Outdent were M2.
- Not done: RTL list margins, selection highlight over list markers (Android lines, they stay
  Android-tagged); no spec line moved this milestone.

## M4 notes

- Carry-overs: a fully selected list row now highlights its rendered marker (`highlightedMarkerRect`
  in the layout fragment, repainted by invalidating the old and new selection's range; Mason D3 /
  decision 7), and the line moved to `mobile/lists.md` (dade6d9b7 on `android-text-first`).
  Android's touch handler consumes a checkbox touch, so iOS does the same: while a touch starts on
  a checkbox, a link or a resolved wikilink the text view refuses first responder (no caret, no
  keyboard) and the caret the tap moved is put back. Verified on the simulator: with the keyboard
  down, a checkbox tap toggled it (no keyboard), a wikilink tap opened the note, a link tap
  recorded the open. A new *(mobile)* line records this.
- RTL list/quote margins stay deferred (Android line `markdown-elements.md` "right-to-left
  paragraph", still Android-tagged): the iOS fragments assume left-to-right.
- Link taps: the styler tags glyphs with `tfLinkURL`/`tfWikilink`; the tap handler hit-tests the
  glyph under the finger (the blank space past a line's end is not a link) and opens through the
  app's `editorNavigationDecision`. A wikilink tap pushes the note (`Route.note`); coming back
  re-attaches this editor (the leave closed it). Unresolved wikilinks do nothing.
- Completion: after every accepted change and selection change the controller asks the engine for
  `wikilink_completion`; candidates show as an inline list above the keyboard toolbar (accept /
  Close; dismissal is remembered per claim start). `refresh_note_ids` runs on open and when the
  vault's notes change, redrawing only the projections the engine names.
- Link item: a prompt (label, destination; Add/Update, Remove, Cancel) reusing the catalog's
  `editor.linkPrompt.*` keys; the engine spells the link (it may write `<...>` around a URL).
- Not unit-tested: the prompt's UIAlertController presentation and the completion list's
  rendering (the engine calls behind them are).

## M5 notes

- Engine: the style plan carries `Image` (range of the glyphs, destination, alt, `vault`, `remote`,
  kept whole by the line splitter). !590 had not merged, so !593/!594 merge it into their branches.
- Drawing (no view providers): the display keeps `![alt](dest)`; the styler hides those glyphs
  (0.01 pt clear font), puts a kern as wide as the image on the FIRST glyph (so a break can never
  fall inside the run and words flow past), and sets the paragraph's minimum line height to the
  image's height. `TextFirstLayoutFragment` draws the bitmap (or a placeholder / alt-text box) at the
  glyph's x (plus the paragraph's head indent: `locationForCharacter` excludes it). One
  `TextFirstImageSpan` per occurrence, one interned `TextFirstImageAtom` per destination so a
  restyle (every keystroke) finds the decoded bitmap. NSTextAttachment view providers were not used:
  they need a U+FFFC in the text, which would break display-text-only; so the iOS 27
  `registerTextAttachmentViewProviderReusePolicy` has nothing to apply to.
- Loading (`TextFirstImageLoader`): vault references percent-decoded and kept inside the vault
  root (symlinks resolved), image extensions only; ImageIO thumbnails sized to the display width,
  EXIF-upright; remote through an ephemeral URLSession (no URL cache, platform TLS; the app's ATS
  already allows http). Sizes are points = pixels / screen scale, never wider than the line (minus a
  list/quote indent). Loads wait until the view has a width; a width change relays out and
  re-decodes larger if needed. Failed loads retry after 10 s (vault) / 30 s (remote). Scroll anchor is
  held when a load changes heights above the screen.
- Interaction: caret stops only at an image's ends (nearest end; one glyph step from an end jumps
  across); a tap selects the image as one object (engine Enter keeps it and acts after); caret
  Backspace/Delete next to an image removes it whole (`deleteImage`: the engine's Backspace removes
  one grapheme, which would leave `![](p.png` as text; Android has that gap too, an engine-level fix
  would serve both); text typed after an image is plain.
- Adding: Camera/Image toolbar items, and a paste that is an image with no text, take the engine's
  `image_claim` first, save through `VaultImages.save` (now takes a root) and present the claim to
  `insert_image`; a refused insertion (stale claim, caret in code) deletes the file. The camera
  checkpoints first. `canPerformAction(paste)` is true for an image alone; adaptive image glyphs
  (Genmoji) are off.
- Not done: tables refuse image content (M6); iOS has no `commitContent` analogue; no persisted
  camera-recreation recovery (Android needed it for process death; iOS only checkpoints); VoiceOver
  reads the hidden Markdown spelling, not the alt text; no per-image accessibility element.
- Spec: four lines moved to `docs/spec/editor/mobile/images.md` (30683320d on `android-text-first`):
  inline drawing + caret stops/tap/Enter (new), remote http(s), the picker claim, image paste. The
  `commitContent` and camera-recreation lines stay Android's.
- Swift lint: baseline had 139 swift-format violations in the text-first files; the whole set is
  formatted now, 0.
- Simulator (iOS 27.2, futo-qa-6, flag on): vault images draw (wide, inline mid-sentence with
  words flowing past, in a list item, a missing file as an alt-text box), and a real tap selected an
  image with the keyboard up. The simulator has no camera and PHPicker is out of process, so the
  picker flows are covered by the unit tests only.

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
  source), smart punctuation off. Typing at a link's end lands inside the link (engine behavior on main, allowed by
  interpretation-and-input.md:31), so those rows expect that. The typed-`|---|` table row is a known
  issue until M6: the engine makes it a table, the iOS view shows rows of text.
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
  (`1. ordered N` between other blocks) takes 3-8 s per keystroke in the middle, release build (engine lane measured 72-91 ms/keystroke on its own repro and is filing an issue; my repro is a note of 20k lines cycling heading/bold/bullet/plain/quote/`1. ordered N`/Japanese/blank; no Swift workaround)
  (`inline::spelling::spell_with_anchors` via `Projection::edit_in`); the same note without them
  takes under 100 us, and a note of 20k plain paragraphs 35-265 us. Needs an engine ticket (M3/M8).
- Visual check: with the flag on, `just puppet` reaches the list and the opened note shows display
  text with no markers (no styling yet). Puppet has no native-editor reads, so typing is covered by
  the unit and UI tests.
- Pre-existing failures on the base (`engine/from-android-text-first`, from `b876e63b3` "end every
  authored note write in a line ending"): 9 tests / 20 issues in `FlushDraftVerbTests`,
  `NativeEditorContractSurfaceTests`, `NativeEditorSessionTests`, `RetainedEditorDraftTests` expect
  bytes without the final line ending. Owned by the engine lane; untouched here.
- Spec: the *(Android text-first editor)* system-text-actions line moved to
  `docs/spec/editor/mobile/clipboard.md` as *(mobile)* (unit-tested on iOS), cherry-picked as
  4fedf5ac5 on `android-text-first`.

Deferred inside M1 (by design): no Markdown styling (M2/M3), no toolbar (M2), engine calls on the
main thread (typing) with saves on a serial queue (M8 revisits), no quick open or queued input
before the session exists (the text view appears when the session is attached; M8).

## Human checklist (needs a physical iPhone; never blocks a milestone)

- Dictation (placeholders never reach the file), QuickPath swipe typing, Writing Tools rewrite and
  proofread, third-party keyboards, Apple Pencil Scribble.
- Toolbar behavior over the real keyboard on a phone, arrow-key caret affinity at format boundaries
  (hardware keyboard), VoiceOver reading headings.
- Camera capture, the photo picker, and pasting from Photos/Safari ("Copy Image") into a note; EXIF-rotated camera photos drawing upright; large photos (12 MP) loading without a hitch.
- Real-device keystroke timings at 20k lines (the simulator numbers are not phone numbers).
