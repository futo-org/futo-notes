# Code blocks

### CB01

- **Rule:** Code text is literal, including Markdown-looking lines, tags and links.
- **Why / history:** The first toolbar MR already excluded code from list/quote continuation; code syntax never creates inline formatting.
- **Evidence:** !3; portable-core/fenced-code.md; code-fence-isolation.md
- **Applies:** `slice 6`. **Check:** tests/fences/input.rs

### CB02

- **Rule:** Every code block, including an empty or unmatched one, exposes a valid editable body caret.
- **Why / history:** Fresh missing-code-caret complaint; fences stay hidden and EOF carets remain owned by the code body.
- **Evidence:** !620; !628; portable-core/fenced-code.md
- **Applies:** `slice 6`. **Check:** tests/fences/keys.rs; tests/fences/frame.rs

### CB03

- **Rule:** Enter in code inserts one literal line break with the code line's indentation and container prefix.
- **Why / history:** List-contained code must not accidentally continue the enclosing list; CRLF remains CRLF.
- **Evidence:** portable-core/fenced-code.md; paragraphs-and-lines.md
- **Applies:** `slice 6`. **Check:** tests/fences/physical_rows.rs; tests/fences/keys.rs

### CB04

- **Rule:** An empty last code line at note end can exit the block with Enter.
- **Why / history:** Fresh no-exit-at-EOF report has an engine exit rule; nonfinal code blocks retain their normal newline behavior.
- **Evidence:** portable-core/fenced-code.md; maintainer list, 2026-11-10
- **Applies:** `slice 6`. **Check:** tests/fences/keys.rs; needs desktop story

### CB05

- **Rule:** Selecting the complete code body and pressing Enter creates an editable line after the block.
- **Why / history:** !300's object model and the portable engine retain the block instead of replacing it; this also works at EOF.
- **Evidence:** docs/plan/desktop-editor.md; portable-core/fenced-code.md
- **Applies:** `slice 6`. **Check:** tests/fences/keys.rs; needs desktop select-then-Enter story

### CB06

- **Rule:** Pressing the active Code block button takes touched code rows out of the fence.
- **Why / history:** Fresh reverse-toggle complaint; rows above and below keep their fences and exposed punctuation remains literal.
- **Evidence:** markdown-toolbar/toolbar-commands.md; portable-core/fenced-code.md
- **Applies:** `slice 6`. **Check:** tests/fences/commands.rs

### CB07

- **Rule:** Select All then Code block wraps every written physical line as one safe Undo action.
- **Why / history:** !471 fixed joined lines; the fresh large-note crash requires a desktop mixed-note story, not just a small plain paragraph.
- **Evidence:** !471; portable-core/fenced-code.md; maintainer list, 2026-11-10
- **Applies:** `slice 6`. **Check:** tests/fences/commands.rs; needs a large mixed-note story

### CB08

- **Rule:** Code-format shortcuts cannot convert or destroy an existing code block.
- **Why / history:** !413 fixed preset shortcuts bypassing toolbar guards; desktop plan makes format shortcuts inert inside code.
- **Evidence:** !413; docs/plan/desktop-editor.md
- **Applies:** `slice 6`. **Check:** needs all-shortcuts code-selection story

### CB09

- **Rule:** Code block header fields follow name, language and code in keyboard order.
- **Why / history:** Mason retained !300's feature set: Tab name→language→code; Shift+Tab reverses, entering language from code only at its first position.
- **Evidence:** !300; docs/plan/desktop-editor.md
- **Applies:** `slice 6`. **Check:** needs a spec line and header-focus story

### CB10

- **Rule:** Code header edits are one engine edit and one Undo step while preserving the rest of the info string.
- **Why / history:** !246 tracks first-edit loss of fence info after the language; the plan requires a fence edit rather than shell text surgery.
- **Evidence:** #246; docs/plan/desktop-editor.md; !300
- **Applies:** `slice 6`. **Check:** needs a story for name, language, hl, ll and unknown info

### CB11

- **Rule:** Cmd+A inside code selects its body first and the note on the second press.
- **Why / history:** Selection anchor determines the area; Shift+Up/Down at edges extends outside and copying the whole block includes fences.
- **Evidence:** docs/plan/desktop-editor.md; !300
- **Applies:** `slice 6`. **Check:** needs a spec line and keyboard/copy story

### CB12

- **Rule:** Pasted fence delimiters stay code and grow the containing fence if necessary.
- **Why / history:** !628 folds fixes for block paste escaping empty code and selected frames surviving replacement.
- **Evidence:** !607; !623; !624; !628
- **Applies:** `slice 6`. **Check:** tests/fences/protected_input.rs; tests/clipboard.rs

### CB13

- **Rule:** Code Tab inserts two spaces and Shift+Tab removes up to two spaces within that block.
- **Why / history:** This code-editing intent differs from list nesting and plain-line tabs; commands use the supplied selection range.
- **Evidence:** portable-core/fenced-code.md
- **Applies:** `slice 6`. **Check:** tests/fences/keys.rs

### CB14

- **Rule:** Unsupported code languages remain editable code without syntax coloring.
- **Why / history:** !188 deliberately curated roughly 35 grammars instead of shipping all 128; unknown languages degrade without an error or lost code.
- **Evidence:** !188; docs/spec/editor/markdown-elements.md; docs/spec/editor/performance.md.
- **Applies:** `slice 6`. **Check:** needs unknown-language open/edit/save story.

### CB15

- **Rule:** The Indent toolbar command changes only code body lines and never the opening or closing fence.
- **Why / history:** Justin's 2026-11-09 !604 rework adds a literal tab and removes a tab or up to two spaces; empty fresh blocks target their body line, while frames with no body line have nothing to indent. Code Tab has a separate contract.
- **Evidence:** !604 final description; portable-core/fenced-code.md (later main revision).
- **Applies:** `slice 6`. **Check:** needs code Indent/Outdent story including listed empty code and untouched fences.
