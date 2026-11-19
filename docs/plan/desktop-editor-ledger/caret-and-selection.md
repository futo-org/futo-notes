# Caret and selection

### CS01

- **Rule:** The engine, native selection, drawn caret and highlight describe the same directed range.
- **Why / history:** Mason, 2026-11-04: two selection owners cause visible corrections and wrong input; only active composition leads temporarily.
- **Evidence:** docs/plan/desktop-editor.md; c7c507441; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** desktop/editing.md; tests/desktop-editor-pointer-stories.mjs

### CS02

- **Rule:** A caret at a soft wrap stays on the visual row where it was placed.
- **Why / history:** Repeated CodeMirror and desktop regressions; Mason reaffirmed this on 2026-11-10; an offset alone cannot distinguish the two visual positions.
- **Evidence:** !184; 109958d0a; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** desktop/editing.md soft-wrap rule; needs a story for every sibling movement

### CS03

- **Rule:** Up and Down retain the horizontal column across short, long and wrapped rows.
- **Why / history:** Visual-row navigation landed 2026-06-29; desktop uses the pointer hit-test and forgets the column after another action.
- **Evidence:** !27; 3018ce94b; 9d4a2b6a4
- **Applies:** `desktop now`. **Check:** desktop/editing.md; tests/desktop-editor-pointer-stories.mjs

### CS04

- **Rule:** Home and End reach the current visual row's edges, with Shift extending from the original anchor.
- **Why / history:** A wrapped paragraph's logical end was the wrong caret destination; the current desktop keeps row association.
- **Evidence:** !184; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** desktop/editing.md row-edge rule

### CS05

- **Rule:** Caret movement and deletion respect grapheme boundaries and treat CRLF as one break.
- **Why / history:** Joined emoji, combining text, surrogate pairs and CRLF cannot be split by ordinary motion; malformed foreign coordinates reject atomically.
- **Evidence:** docs/spec/editor/portable-core/interpretation-and-input.md; crates/futo-notes-editor/tests/unicode.rs
- **Applies:** `desktop now`. **Check:** tests/unicode.rs; tests/paragraphs/crlf.rs; needs a desktop story

### CS06

- **Rule:** Word selection, word motion and word deletion use the same ICU4X dictionary segmentation.
- **Why / history:** Mason chose full dictionaries on 2026-11-04; the smaller LSTM data split Thai and Lao incorrectly.
- **Evidence:** 343d21dc8; docs/plan/desktop-editor.md
- **Applies:** `desktop now`. **Check:** crates/futo-notes-editor/tests/words.rs; desktop/editing.md

### CS07

- **Rule:** Select All selects the complete note even when only its visible bands are painted.
- **Why / history:** Fresh complaint: highlight looked painted over the screen and missed the top; DOM selection must still span the entire note.
- **Evidence:** 055240f3b (android-text-first), C2; maintainer list, 2026-11-10; docs/spec/editor/desktop/editing.md; docs/learnings/large-file-editing.md
- **Applies:** `desktop now`. **Check:** desktop/editing.md; needs a story covering top, tail and copied bytes

### CS08

- **Rule:** Selection paint includes blank lines, line breaks and atoms without gaps between adjacent rows.
- **Why / history:** The desktop fixed fractional-edge hairlines on 2026-11-09; painting only glyph rectangles loses empty selected lines.
- **Evidence:** d5ae330c7; docs/spec/editor/desktop/editing.md
- **Applies:** `desktop now`. **Check:** tests/desktop-editor-pointer-stories.mjs

### CS09

- **Rule:** The caret is visible on empty lines and follows the size and baseline of the text being edited.
- **Why / history:** Fresh italic/bold overlap and missing quote/code caret reports; the empty-task caret previously broke because a separator image became block-level.
- **Evidence:** !336; docs/spec/editor/desktop/editing.md; maintainer list, 2026-11-10
- **Applies:** `slice 3`. **Check:** needs a story for bold and italic; quote/code variants are LQ11 and CB02

### CS10

- **Rule:** Empty and nonempty headings keep a stable line box and an unclipped caret.
- **Why / history:** Fresh H1-above-text, H1-Return and empty-heading height reports; the desktop's fixed rhythm makes H1 two whole row units.
- **Evidence:** docs/spec/editor/desktop/editing.md; src/features/editor/desktop/desktopEditor.css; maintainer list, 2026-11-10
- **Applies:** `desktop now`. **Check:** desktop/editing.md; needs a story for empty H1, before H1 and Return

### CS11

- **Rule:** The caret hides on blur and restarts its blink on every edit or move.
- **Why / history:** Mason chose a drawn caret from slice 1 while preserving native selection for input methods and accessibility.
- **Evidence:** docs/plan/desktop-editor.md; src/features/editor/desktop/caret.ts
- **Applies:** `desktop now`. **Check:** desktop/editing.md; needs a focus/blink story

### CS12

- **Rule:** A selection that starts outside an atom or code block takes that object whole.
- **Why / history:** Mason's desktop plan carries !300's object selection rule; partial fence and image selections previously left fragments.
- **Evidence:** !300; #393; docs/plan/desktop-editor.md
- **Applies:** `slice 4`. **Check:** needs a story; engine resolve_selection still pending in the local slice plan

### CS13

- **Rule:** Typing or deleting across a code-block boundary preserves the unselected text and valid fence ownership.
- **Why / history:** !634 (2026-11-09/10) repairs orphan frame ends and validates the entire result; some paragraph-to-list refusals remain open.
- **Evidence:** !634; #339; #348; docs/spec/editor/portable-core/fenced-code.md
- **Applies:** `slice 6`. **Check:** needs a story; read !634's changed heading-after-fence rule before using older refusal tests

### CS14

- **Rule:** A bug with equivalent caret or selection paths is fixed for the whole class at its shared owner.
- **Why / history:** Mason explicitly reaffirmed M17 on 2026-11-10; separate click, motion and settle fixes repeatedly left siblings broken.
- **Evidence:** AGENTS.md M17; maintainer decision, 2026-11-10; !249
- **Applies:** `desktop now`. **Check:** needs a story matrix including click, arrows, Shift, drag, composition and refocus

### CS15

- **Rule:** Unmodified vertical and row-edge motion collapses a selection from its edge in the motion's direction.
- **Why / history:** Shift keeps the original anchor; using the focus end unconditionally produced asymmetric movements for reverse selections.
- **Evidence:** docs/spec/editor/desktop/editing.md, vertical and row-edge bullets.
- **Applies:** `desktop now`. **Check:** desktop/editing.md; needs forward/reverse selection motion stories.

### CS16

- **Rule:** Hiding or styling inline markers leaves caret coordinates aligned with the drawn text.
- **Why / history:** On 2026-04-07 display:none marker decorations broke coordsAtPos and made Up skip wrapped lines; later editors changed the rendering mechanism but still need coherent boundary geometry.
- **Evidence:** 6c74da944; desktop/editing.md.
- **Applies:** `slice 3`. **Check:** needs a wrapped bold/code boundary story on every desktop engine; the old hidden-marker CSS is obsolete.
