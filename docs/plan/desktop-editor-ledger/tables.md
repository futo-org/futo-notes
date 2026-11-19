# Tables

### TB01

- **Rule:** Table edits retain cell boundaries, untouched rows and alignment.
- **Why / history:** The CM6 table editor lost left alignment; !371 fixed wider rows shifting values and paste losing alignment.
- **Evidence:** !195 discussion; !371; portable-core/tables.md
- **Applies:** `slice 9`. **Check:** tests/tables.rs; needs desktop alignment/untouched-bytes story

### TB02

- **Rule:** Tab and Shift+Tab navigate cells and Tab at the last cell appends a row.
- **Why / history:** Enter moves to the same column below and adds a row only from the last row; navigation selects cell content without adding Undo.
- **Evidence:** docs/spec/editor/interactive-elements.md; portable-core/tables.md
- **Applies:** `slice 9`. **Check:** tests/tables.rs; needs desktop keyboard story

### TB03

- **Rule:** Mod+Enter exits a table into an editable paragraph below it.
- **Why / history:** A table at EOF cannot trap the caret; shells previously had no table context menu.
- **Evidence:** !275; portable-core/tables.md
- **Applies:** `slice 9`. **Check:** tests/tables.rs; needs desktop EOF-table story

### TB04

- **Rule:** Shift+Enter in a cell creates the specified in-cell break without changing row structure.
- **Why / history:** Shipping Milkdown writes `<br>`; the engine's remaining-work file still records incomplete `<br>` display projection.
- **Evidence:** interactive-elements.md; portable-core/tables.md; portable-core/remaining-work.md
- **Applies:** `slice 9`. **Check:** needs a desktop save/reopen story before claiming parity

### TB05

- **Rule:** Ordinary multiline paste stays inside the selected cell.
- **Why / history:** !370 and !374 separately fixed plain and HTML paste overwriting the next cell.
- **Evidence:** !370; !374; portable-core/tables.md
- **Applies:** `slice 9`. **Check:** tests/tables.rs; needs plain/rich multiline cell story

### TB06

- **Rule:** Typed pipes in a cell are escaped while the table's actual separator pipes remain structural.
- **Why / history:** All input paths use one cell policy; a change that would alter column count rejects as a whole.
- **Evidence:** portable-core/tables.md; !363
- **Applies:** `slice 9`. **Check:** tests/tables.rs; needs composition/OS replacement cell story

### TB07

- **Rule:** A header-only table does not gain a written empty body row until content is added.
- **Why / history:** !448/!471 fixed header-only HTML paste; filler rows may be displayed without changing the note.
- **Evidence:** markdown-house-style.md Tables; !448; !471
- **Applies:** `slice 9`. **Check:** needs header-only paste/save/reopen story

### TB08

- **Rule:** Empty edge cells remain present when their text is cleared.
- **Why / history:** !627 folds bounded clearing of edge cells; an escaped edge pipe is content, not a separator.
- **Evidence:** !610; !627; d8ccfb2be (later origin/main)
- **Applies:** `slice 9`. **Check:** tests/tables.rs on main; needs edge-cell story

### TB09

- **Rule:** A table remains visible after scrolling it away and back.
- **Why / history:** !278 fixed reusing cached detached cell elements when CodeMirror remounted the same widget instance.
- **Evidence:** !278; github#41; !153 discussion
- **Applies:** `slice 9`. **Check:** needs desktop scroll-away/return story; old CM6 mechanism is obsolete

### TB10

- **Rule:** Table parsing and style planning inspect each nonblank run once and restyle only affected rows.
- **Why / history:** !602 fixed pipe-containing non-tables taking 40 seconds at 8,000 lines; !596 review bounded table output to the style window.
- **Evidence:** !602; !596 discussion; portable-core/tables.md
- **Applies:** `slice 9`. **Check:** tests/table_inspect_all.rs; tests/host_style_plan.rs

### TB11

- **Rule:** Table alignment changes, grid paste and row or column reordering remain deferred.
- **Why / history:** Maintainer, 2026-10-30: cell editing and basic row/column insertion/deletion still required; block-level table selection is separately undecided.
- **Evidence:** #309; #310; docs/plan/desktop-editor.md; portable-core/remaining-work.md
- **Applies:** `slice 9`. **Check:** needs a desktop table spec line before expanding the basic scope

### TB12

- **Rule:** Tables in list and quote containers must not be claimed as supported by the current engine.
- **Why / history:** The local engine recognizes root GFM tables only; #362/#365 identify related discovery failures.
- **Evidence:** portable-core/tables.md; #362; #365
- **Applies:** `slice 9`. **Check:** needs a spec line or explicit accepted limit at desktop integration

### TB13

- **Rule:** An edit outside a known table keeps its widget even before parsing reaches that table again.
- **Why / history:** !153 review caught load-dependent table disappearance beyond the transient parse frontier; Mason fixed it on 2026-08-03, while edits inside an unparsed table deliberately remove stale paint until reparse.
- **Evidence:** !153 discussion (Justin 2026-07-31; Mason 2026-08-03); 87d12cef (MR source branch claude/sidebar-typing-performance-c6f07f; no current branch contains this original commit).
- **Applies:** `slice 9`. **Check:** needs a story; historical interactiveTableEditor tests distinguish edits above and inside a table.

### TB14

- **Rule:** Table spacing, estimated height and painted bounds agree with hit testing and caret geometry.
- **Why / history:** !264 found eight-pixel margins missing from CM6's measured box, accumulating wrong clicks and Cmd+Backspace targets; estimates were about six pixels short per row. Dividers had the same class of failure.
- **Evidence:** !264; historical tests/editor-height-map.spec.ts@875122977.
- **Applies:** `slice 9`. **Check:** needs geometry story across two tables, an image and dividers.

### TB15

- **Rule:** Table hover controls align to live row and column bounds after mutation and horizontal scrolling.
- **Why / history:** !264 replaced detached-element offsets and hides offscreen controls. WebKit does not refire pointerenter after mutation under a stationary pointer, so Chromium masked the defect.
- **Evidence:** !264; historical tests/table-controls-position.spec.ts@2861de821.
- **Applies:** `slice 9`. **Check:** needs WebKit desktop table-controls story.

### TB16

- **Rule:** Table controls refuse deleting the header, final body row or final column and refuse inserting above the header.
- **Why / history:** These guards keep a visible table valid; mutation preserves untouched alignment and pipes even when only one column remains.
- **Evidence:** portable-core/tables.md; !344; tests/editor-embed-milkdown-table-grips.spec.ts.
- **Applies:** `slice 9`. **Check:** tests/tables.rs; needs disabled-menu and one-column save/reopen stories.
