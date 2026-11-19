# Typing, composition and input methods

### TI01

- **Rule:** Each accepted desktop input changes the engine before the view reports the resulting display.
- **Why / history:** The browser owns DOM mutations only during composition; every other editing path uses beforeinput intent.
- **Evidence:** docs/spec/editor/desktop/editing.md; crates/futo-notes-editor/AGENTS.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-stories.mjs

### TI02

- **Rule:** A keystroke never disappears when formatting or block syntax cannot be represented.
- **Why / history:** Fresh strike+italic/bold combinations reproduce the broad lost-input risk; the engine property suite promises every typed letter lands, using escapes today.
- **Evidence:** 055240f3b (android-text-first), F1; 28a0ba971 (android-text-first); 29e0f67b9 (android-text-first); portable-core/interpretation-and-input.md; maintainer list, 2026-11-10
- **Applies:** `slice 3`. **Check:** inline/stacked_formats.rs; needs a desktop story; escaping conflicts with MD01

### TI03

- **Rule:** Marked composition is provisional and commits once as one isolated Undo action.
- **Why / history:** Repeated updates replace the complete overlay without source/history changes; cancel preserves the accepted document.
- **Evidence:** docs/spec/editor/portable-core/interpretation-and-input.md; tests/composition.rs
- **Applies:** `desktop now`. **Check:** crates/futo-notes-editor/tests/composition.rs; desktop composition stories

### TI04

- **Rule:** Composition draws the formats the committed text will carry, including in headings.
- **Why / history:** The engine supplies composition runs so marked input must not appear plain until commit.
- **Evidence:** docs/spec/editor/portable-core/interpretation-and-input.md; session/composition/marked.rs
- **Applies:** `slice 3`. **Check:** tests/composition.rs; needs a formatted composition story

### TI05

- **Rule:** Formatting during composition commits the text before changing carried formats.
- **Why / history:** History remains two coherent actions; pending text must not be lost or accepted twice.
- **Evidence:** docs/spec/editor/portable-core/interpretation-and-input.md
- **Applies:** `slice 3`. **Check:** crates/futo-notes-editor/tests/composition.rs

### TI06

- **Rule:** Undo and Redo do nothing while marked text is pending.
- **Why / history:** A native selection notification cannot move the pinned composition range; hosts cannot mix staged and host-owned commit modes.
- **Evidence:** docs/spec/editor/portable-core/interpretation-and-input.md
- **Applies:** `desktop now`. **Check:** crates/futo-notes-editor/tests/composition.rs

### TI07

- **Rule:** An IME commit between inline atoms ends composition without dropping or duplicating subsequent input.
- **Why / history:** !377 fixed compositionend consumption; !382 fixed composing over a selected chip.
- **Evidence:** !377; !382; 06e7e610d
- **Applies:** `slice 5`. **Check:** needs a desktop story with image/chip gaps, replacing a selection and immediate next character

### TI08

- **Rule:** An autocorrect or double-space-period replacement ending at the caret retains carried formatting.
- **Why / history:** Justin's !564 discussion, 2026-11-06 points Android to !597's shared fix; losing the toggle made the next sentence plain.
- **Evidence:** !597; !564 discussion; tests/inline/toolbar.rs
- **Applies:** `slice 3`. **Check:** portable-core/interpretation-and-input.md; needs a desktop text-service story

### TI09

- **Rule:** An operating-system replacement preserves unchanged formatted runs and ends at the replacement's actual end.
- **Why / history:** Whole supplied native ranges can include kept text; multi-run replacements validate all opening coordinates before one acceptance.
- **Evidence:** docs/spec/editor/portable-core/interpretation-and-input.md; tests/compound_composition.rs
- **Applies:** `desktop now`. **Check:** tests/compound_composition.rs; tests/native_input_traces.rs

### TI10

- **Rule:** Empty-note Backspace is a no-op and opening the menu afterward cannot crash.
- **Why / history:** Colt reported the original 2026-02 failure; an unrelated Chromium/FUTO Keyboard crash later needed a temporary shield.
- **Evidence:** !1; a44424375; tests/p0-regressions.spec.ts
- **Applies:** `desktop now`. **Check:** p0-regressions.spec.ts; needs equivalent desktop story

### TI11

- **Rule:** Enter inside a composition inserts exactly one intended line break after the commit.
- **Why / history:** !470 fixed an Android return lost when the browser did not split; physical composing-keyboard coverage remained blocked in its review.
- **Evidence:** !470 discussion; #277; docs/spec/editor/android-ime.md
- **Applies:** `mobile only`. **Check:** Android InputConnection/composing-Enter path; desktop composition-confirm Enter needs its own no-extra-break story

### TI12

- **Rule:** Prose keeps autocorrect and sentence capitalization while code disables both.
- **Why / history:** !300 review caught blockquote-ish becoming block quote-ish and print becoming Print; Mason fixed traits in the web editor and iOS host on 2026-09-10.
- **Evidence:** !300 discussion; cursor/typing-and-ime.md
- **Applies:** `slice 6`. **Check:** needs a desktop native text-service story; spellcheck remains off by desktop plan

### TI13

- **Rule:** A completed composition cannot be interrupted by a sidebar, blur or save callback.
- **Why / history:** The first IME safety fix was !1; current ownership must defer unrelated source adoption until composition ends.
- **Evidence:** !1; !177; tests/p0-regressions.spec.ts
- **Applies:** `desktop now`. **Check:** p0 composition/sidebar regression; needs desktop story

### TI14

- **Rule:** Invalid foreign text or coordinates reject before changing source, selection or history.
- **Why / history:** The old Tauri path hung on lone surrogates and repaired them to U+FFFD; the new engine validates native UTF-16 instead of accepting malformed strings.
- **Evidence:** !376; docs/spec/editor/portable-core/interpretation-and-input.md
- **Applies:** `desktop now`. **Check:** tests/unicode.rs; host adapter behavior needs a story

### TI15

- **Rule:** Apple editing keys keep their native editing meaning without inserting private-use or control characters.
- **Why / history:** Ctrl+K/Y kill/yank, Ctrl+T transpose and Ctrl+O split are explicit; Ctrl+Q is disabled to avoid quoted function-key text.
- **Evidence:** docs/spec/editor/desktop/editing.md; tests/paragraphs/tab_and_transpose.rs
- **Applies:** `desktop now`. **Check:** desktop/editing.md; needs macOS shortcut stories

### TI16

- **Rule:** Enter in ordinary prose does not carry an accidental run of leading spaces onto each following line.
- **Why / history:** Justin's 2026-05-13 fix stopped CodeMirror's default indentation from spreading stray spaces; it deliberately retained tab outline indentation then, while the current engine's plain Enter promises one line break.
- **Evidence:** 1a728b2ca; portable-core/interpretation-and-input.md.
- **Applies:** `desktop now`. **Check:** needs a leading-space Enter story and an explicit decision before restoring old tab propagation.
