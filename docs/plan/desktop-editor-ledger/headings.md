# Headings

### HG01

- **Rule:** Enter after heading text creates a paragraph and Enter before it leaves a line above the heading.
- **Why / history:** This is established across both editor generations; selection replacement happens before the structural key.
- **Evidence:** docs/spec/editor/paragraphs-and-lines.md; portable-core/block-commands.md
- **Applies:** `desktop now`. **Check:** tests/blocks/keys.rs; needs a desktop story

### HG02

- **Rule:** Desktop Backspace before nonempty heading text removes the preceding newline while retaining the appropriate joined block style.
- **Why / history:** Blank line above disappears; text above absorbs the heading text; at note start nothing happens; only an empty heading becomes text.
- **Evidence:** 8d40149a9; d0e7f7de9; docs/plan/text-first-mason-feedback-2026-11.md@055240f3b (android-text-first), 2A; tests/blocks/heading_joins.rs
- **Applies:** `desktop now`. **Check:** tests/blocks/heading_joins.rs; needs a desktop story

### HG03

- **Rule:** The mobile BackspaceJoiningHeading command retains its explicit first-line and joining policy.
- **Why / history:** Mobile's command makes a first-line heading Text and historically refused a join after code; desktop's plain Backspace is distinct and !634 changes the code-boundary case.
- **Evidence:** portable-core/interpretation-and-input.md; !634; tests/blocks/heading_join.rs
- **Applies:** `mobile only`. **Check:** README decision B; do not copy this command into desktop

### HG04

- **Rule:** Pressing the active H1, H2 or H3 toolbar button turns the selected heading into Text.
- **Why / history:** Fresh header-toggle complaint; explicit Heading remains idempotent while ToggleHeading performs the reversible UI action.
- **Evidence:** 055240f3b (android-text-first), 3A; portable-core/block-commands.md; tests/blocks/toggle.rs; maintainer decision, 2026-11-10
- **Applies:** `slice 3`. **Check:** tests/blocks/toggle.rs; needs a desktop toolbar story

### HG05

- **Rule:** Heading commands ignore blank lines and front matter in wider selections.
- **Why / history:** !600 fixed Select All turning separator lines into empty headings and leaving no common toolbar state.
- **Evidence:** !600; portable-core/block-commands.md
- **Applies:** `slice 3`. **Check:** tests/blocks/blank_lines.rs

### HG06

- **Rule:** Changing heading level applies to the full semantic heading while retaining its inline text and enclosing quotes.
- **Why / history:** Setext soft lines fold to spaces; unchanged level remains an exact-source no-op.
- **Evidence:** portable-core/block-commands.md; tests/blocks/commands.rs
- **Applies:** `slice 3`. **Check:** tests/blocks/commands.rs; tests/blocks/projection.rs

### HG07

- **Rule:** Delete at the start of heading text deletes the next character without changing its level.
- **Why / history:** The parity fix separates forward character deletion from block lifting.
- **Evidence:** docs/spec/editor/paragraphs-and-lines.md
- **Applies:** `desktop now`. **Check:** needs a desktop story

### HG08

- **Rule:** H4 through H6 do not light the Paragraph button.
- **Why / history:** !636, 2026-11-10: a heading lacking a matching toolbar control must light no block control.
- **Evidence:** !636; 65b73bf23 (later origin/main)
- **Applies:** `slice 3`. **Check:** tests/host_toolbar_ids.rs on main; needs a desktop toolbar story

### HG09

- **Rule:** The desktop title remains a separate verbatim filename field rather than the first heading.
- **Why / history:** M2 forbids title prettification; Mason explicitly retained the separate field in the desktop plan.
- **Evidence:** AGENTS.md M2; docs/plan/desktop-editor.md
- **Applies:** `desktop now`. **Check:** tests/p2-regressions.spec.ts; needs desktop title/body story
