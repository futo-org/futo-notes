# Undo and Redo

### UN01

- **Rule:** Undo history belongs to the note session and never crosses a note switch.
- **Why / history:** !206 fixed previous-note text overwriting and autosaving into another note; equal-byte notes must also reset identity.
- **Evidence:** !206; github#20; !484
- **Applies:** `desktop now`. **Check:** tests/history.rs; needs two-note and equal-byte desktop stories

### UN02

- **Rule:** Opening, progressive append and derived display work do not create Undo steps.
- **Why / history:** !206 fixed Undo blanking a newly opened mobile note; a streamed suffix is not user input.
- **Evidence:** !206; docs/spec/editor/performance.md; portable-core/interpretation-and-input.md
- **Applies:** `desktop now`. **Check:** tests/history.rs; needs load-then-Undo desktop story

### UN03

- **Rule:** Undo reverses a user list edit and its renumbering together without retriggering renumbering.
- **Why / history:** !195 review retracted its regression attribution; !206 fixed the pre-existing pasted-list history loop.
- **Evidence:** !195 discussions, 2026-08-06/07; !206
- **Applies:** `slice 4`. **Check:** tests/history.rs; tests/lists/keys.rs; needs paste-wrong-numbers desktop story

### UN04

- **Rule:** Undo and Redo restore exact source, selection direction, affinity and carried formatting.
- **Why / history:** The engine owns source inverses instead of relying on serialized display text; failed acceptance preserves both stacks.
- **Evidence:** portable-core/interpretation-and-input.md; tests/history.rs
- **Applies:** `desktop now`. **Check:** crates/futo-notes-editor/tests/history.rs

### UN05

- **Rule:** Adjacent single-grapheme typing or same-direction deletion groups only within the engine's 500 ms boundary.
- **Why / history:** Exactly 500 ms, a backward clock, movement, newline or an isolated action starts another group; overall Undo feel remains deferred for tuning.
- **Evidence:** portable-core/interpretation-and-input.md; docs/plan/desktop-editor.md Later
- **Applies:** `desktop now`. **Check:** tests/history.rs; needs a desktop grouping story

### UN06

- **Rule:** A command, paste or drag-to-move is one intended Undo action.
- **Why / history:** Composition commit and a following structural command retain separate history actions despite one acceptance.
- **Evidence:** portable-core/clipboard.md; docs/plan/desktop-editor.md; 53c0dd843
- **Applies:** `desktop now`. **Check:** tests/history/compound.rs; tests/move_text.rs

### UN07

- **Rule:** Undo or Redo is disabled when its stack is empty, including refusing the actual action.
- **Why / history:** The mobile toolbar once only dimmed visually; its manifest and engine history state must agree.
- **Evidence:** markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 3`. **Check:** tests/host_toolbar_ids.rs; needs a desktop empty-history toolbar story

### UN08

- **Rule:** An external merge becomes one ordinary undoable edit that retains prior local history.
- **Why / history:** !574/!576 merge independent paragraph and within-paragraph changes; desktop slice 8 adopts the result once.
- **Evidence:** !574; !576; docs/plan/desktop-editor.md
- **Applies:** `slice 8`. **Check:** needs external-merge/Undo desktop story
