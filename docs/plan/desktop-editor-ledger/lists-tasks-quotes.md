# Lists, tasks, quotes and dividers

### LQ01

- **Rule:** List markers and wrapped continuation rows align at the item's content column.
- **Why / history:** The 2026-08-14 hanging-indent decision reverses 2026-06-10 left-margin wrapping; !226 also fixed leading indentation. Wrapped rows align under text, including wide numbers and nested tasks.
- **Evidence:** !226; docs/spec/editor/markdown-elements.md
- **Applies:** `slice 4`. **Check:** needs a desktop visual story with nested and wide-numbered lists

### LQ02

- **Rule:** Enter splits a list item, keeps the old checkbox state and creates an unchecked next task.
- **Why / history:** Fresh list continuation risk includes empty bodies; Enter at text start inserts an unchecked item above and leaves the caret on the original text.
- **Evidence:** !448; portable-core/lists.md
- **Applies:** `slice 4`. **Check:** tests/lists/enter_at_start.rs; tests/lists/enter_split.rs

### LQ03

- **Rule:** Enter on an empty nested item outdents one level, carrying its following siblings as children.
- **Why / history:** Maintainer decision, 2026-11-02, follows Google Docs and Notion; ordered levels renumber independently.
- **Evidence:** portable-core/lists.md; tests/lists/keys.rs
- **Applies:** `slice 4`. **Check:** tests/lists/keys.rs; needs a desktop story

### LQ04

- **Rule:** Enter on an empty root item exits the list and leaves subsequent text outside it.
- **Why / history:** A blank separator prevents the next typed text from becoming lazy list continuation; enclosing quotes remain.
- **Evidence:** portable-core/lists.md
- **Applies:** `slice 4`. **Check:** tests/lists/projection.rs; tests/lists/keys.rs

### LQ05

- **Rule:** Indent nests under the previous sibling and Outdent removes one nesting level, moving the item's descendants with it.
- **Why / history:** Justin's final 2026-11-09 rule in !604 replaces the earlier refusal-heavy list planner.
- **Evidence:** !604; !632; docs/spec/editor/portable-core/lists.md is stale locally
- **Applies:** `slice 4`. **Check:** needs a story against main's list-indent.md and a local spec update before integration

### LQ06

- **Rule:** An empty item can be indented immediately after Enter without waiting for future typing.
- **Why / history:** Held indentation was replaced by refusal, then accepted by !599; !604 later changes the spelling toward tab-based nesting.
- **Evidence:** !599; !604; !564 discussion, 2026-11-06
- **Applies:** `slice 4`. **Check:** tests/lists/indent_empty_item.rs; local blank-line examples are historical

### LQ07

- **Rule:** Indent is disabled for a list's first item and Outdent for a root item or same-line parent item.
- **Why / history:** !604 narrowed disabled states to places where no sensible nesting exists; Enter/Backspace provide list exits instead.
- **Evidence:** !604; !632 discussion dropping !613
- **Applies:** `slice 4`. **Check:** needs a desktop eligibility story; local lists.md predates this final rule

### LQ08

- **Rule:** Tab and Shift+Tab use the same list commands and eligibility as the toolbar.
- **Why / history:** Desktop text lines already use leading tabs; a disabled list key must not silently insert a text tab.
- **Evidence:** docs/plan/desktop-editor.md; portable-core/lists.md
- **Applies:** `slice 4`. **Check:** tests/lists/tab.rs; needs a desktop story

### LQ09

- **Rule:** Converting list kinds preserves nesting and converts checkbox state only when that state ceases to apply.
- **Why / history:** !252 fixed accumulating incompatible prefixes; Task must not also read as Bullet.
- **Evidence:** !252; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 4`. **Check:** needs a conversion-matrix story

### LQ10

- **Rule:** Checkbox changes preserve the caret, selection and carried formats without stealing focus.
- **Why / history:** Task toggles originally failed to persist; later Android offset bugs also hid the keyboard at text start.
- **Evidence:** 898d6f8a2; !3; !453; tests/p2-regressions.spec.ts
- **Applies:** `slice 4`. **Check:** tests/lists/fixtures.rs; needs a desktop click-without-focus story

### LQ11

- **Rule:** Quote toggles on the first press and removes one level when all eligible selected text is already quoted.
- **Why / history:** Fresh new-note quote and reverse-toggle reports have a current engine rule; immediate typing must look quoted without an extra Enter.
- **Evidence:** portable-core/block-commands.md; maintainer list, 2026-11-10
- **Applies:** `slice 4`. **Check:** tests/blocks/toggle.rs; needs empty-note and mixed Select All stories

### LQ12

- **Rule:** Quote Enter inserts one quoted line and an empty quoted line exits one quote level.
- **Why / history:** The 2026-02 implementation already stepped down nested quotes; the engine later removes Milkdown's extra blank separator behavior.
- **Evidence:** 9c0684cd0; !3; portable-core/block-commands.md
- **Applies:** `slice 4`. **Check:** tests/blocks/quote_enter.rs; tests/blocks/keys.rs

### LQ13

- **Rule:** Enter at a quote's first visible text leaves a plain line above its outermost starting quote.
- **Why / history:** !475 fixes the quote-start case; a blank line inside would disappear on save.
- **Evidence:** !475; paragraphs-and-lines.md; portable-core/block-commands.md
- **Applies:** `slice 4`. **Check:** tests/editor-embed-milkdown-interactive-quote-start.spec.ts; needs desktop story

### LQ14

- **Rule:** Select All then Quote changes all eligible rows without touching fenced code or the unwritten final blank.
- **Why / history:** Fresh large-note Quote no-op complaint; the engine has an explicit mixed-note regression.
- **Evidence:** portable-core/block-commands.md; maintainer list, 2026-11-10
- **Applies:** `slice 4`. **Check:** tests/blocks/toggle.rs select_all_quote_changes_eligible_rows_in_a_mixed_note

### LQ15

- **Rule:** A divider leaves an editable paragraph below it and Undo does not append another paragraph.
- **Why / history:** !370 fixed divider replay changing older history; syntax may use *** where --- would become setext.
- **Evidence:** !370; portable-core/block-commands.md
- **Applies:** `slice 4`. **Check:** tests/blocks.rs; needs desktop atom/Undo story

### LQ16

- **Rule:** List edits never insert invisible HTML comments to keep lists apart.
- **Why / history:** !625, folded into !632, reverses the old separator repair; lists merge as plain Markdown reads them and existing comments remain raw HTML.
- **Evidence:** !625; !632; 0672f50c1 (later origin/main)
- **Applies:** `slice 4`. **Check:** needs a spec line locally; local lists.md still authorizes `<!-- -->`

### LQ17

- **Rule:** Quoted list keys preserve container ownership and never panic on split tabs.
- **Why / history:** !630 fixed slicing an empty marker for > followed by tab and list; !632 preserves quotes on list commands.
- **Evidence:** !630; !632; 403258e2b (later origin/main)
- **Applies:** `slice 4`. **Check:** tests/lists/quote_tab_enter.rs on main; needs desktop story

### LQ18

- **Rule:** A list item's heading continues as a plain next item while retaining the left heading and closing hashes.
- **Why / history:** !617, folded into !632, fixed repeated heading prefixes on Enter; midline, selection, CRLF and carried formats are covered.
- **Evidence:** !617; !632
- **Applies:** `slice 4`. **Check:** tests/lists/enter_split.rs on main; needs desktop heading-in-list story

### LQ19

- **Rule:** Explicit Heading or Quote formats every selected nested item while retaining unselected descendants.
- **Why / history:** !606 and !615 fixed lost endpoint targets and parent/child selections being refused; !632 preserves those changes.
- **Evidence:** !606; !615; !632
- **Applies:** `slice 4`. **Check:** tests/lists/lifting.rs on main; needs endpoint and nested-selection story

### LQ20

- **Rule:** Deep nesting stays readable by bounding visual indentation before it consumes the text column.
- **Why / history:** A 590-byte, 20-level list went blank when deep padding reduced its content width to zero. Milkdown uses 1.4em per level for 1–4, 0.7em for 5–8 and no further growth from 9: maximum 8.4em.
- **Evidence:** docs/spec/editor/markdown-elements.md; tests/editor-embed-milkdown-deep-nesting.spec.ts.
- **Applies:** `slice 4`. **Check:** needs a story with deep bullets, tasks and quotes.

### LQ21

- **Rule:** Task checkboxes have a usable hit target without shifting text or intruding into the gutter.
- **Why / history:** The existing marker geometry separates the checkbox target from text alignment; !453 retains its 28-pixel target through the IME repair.
- **Evidence:** docs/spec/editor/interactive-elements.md; tests/bullet-glyphs.spec.ts; !453.
- **Applies:** `slice 4`. **Check:** needs a story for checkbox center, margins and wrapped text.

### LQ22

- **Rule:** Quote indentation and wrapped rows stay aligned through caret and selection moves.
- **Why / history:** !231 fixed spelling-dependent gutters and caret reveal shifts; Justin's 2026-08-18 review also found wrapped continuation rows one gutter too far left and deep-level fallback errors.
- **Evidence:** !231 discussion; docs/spec/editor/markdown-elements.md.
- **Applies:** `slice 4`. **Check:** needs quote-depth, lazy-continuation and wrapped-row caret geometry stories.
