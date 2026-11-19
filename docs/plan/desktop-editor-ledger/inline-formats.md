# Inline formats and format edges

### IF01

- **Rule:** Bold, italic, strike and inline code can coexist in heading text and survive saving.
- **Why / history:** Mason explicitly chose emphasis in headings on 2026-11-04; Android TfHeading overwrote the emphasis typeface, leaving only strike visible; desktop has not drawn inline spans yet.
- **Evidence:** docs/plan/text-first-mason-feedback-2026-11.md@055240f3b (android-text-first), decision 1A; tests/host_style_plan.rs; maintainer list, 2026-11-10
- **Applies:** `slice 3`. **Check:** needs a story and explicit rendering spec line; README decision H

### IF02

- **Rule:** A collapsed formatting toggle changes carried state without writing empty markers.
- **Why / history:** Mason's 2026-11-03/04 plan keeps the current engine behavior; moving the caret drops the override.
- **Evidence:** docs/plan/desktop-editor.md; portable-core/interpretation-and-input.md
- **Applies:** `slice 3`. **Check:** tests/inline/toolbar.rs

### IF03

- **Rule:** A selected formatting toggle preserves visible text and selection and forms one Undo action.
- **Why / history:** Unsafe candidate spelling must never partially apply; deletion of marked content keeps the format carried for the next input.
- **Evidence:** portable-core/interpretation-and-input.md; tests/inline.rs
- **Applies:** `slice 3`. **Check:** tests/inline.rs; tests/inline/multi_block.rs

### IF04

- **Rule:** Across multiple blocks a format toggle applies independently to each eligible inline body.
- **Why / history:** A whole mixed selection cannot become one span over block syntax or a code fence.
- **Evidence:** portable-core/interpretation-and-input.md; tests/inline/multi_block.rs
- **Applies:** `slice 3`. **Check:** needs a desktop mixed-heading/list/code story

### IF05

- **Rule:** At a format edge the caret joins the more formatted side, with a left-side tie break.
- **Why / history:** Mason's desktop plan explicitly calls this a prototype rule to tune when formats are drawn.
- **Evidence:** docs/plan/desktop-editor.md format edges
- **Applies:** `slice 3`. **Check:** needs a story and final spec line after tuning

### IF06

- **Rule:** A link never grows at either boundary.
- **Why / history:** The formatting-edge plan separates link extent from adjacent emphasis; a line-start caret otherwise inherits its first character's formatting.
- **Evidence:** docs/plan/desktop-editor.md; portable-core/links.md
- **Applies:** `slice 5`. **Check:** needs edge-insertion stories

### IF07

- **Rule:** Right at a formatted line end turns formatting off and defers any needed separating space until typing.
- **Why / history:** The plan says one visual character per Right; pending space is absent when the previous character is already a space.
- **Evidence:** docs/plan/desktop-editor.md format edges
- **Applies:** `slice 3`. **Check:** needs a story and final spec line

### IF08

- **Rule:** A pennant on the drawn caret shows carried inline and heading formatting.
- **Why / history:** Mason chose the solid flag without a fade; hiding while typing remains a prototype toggle.
- **Evidence:** docs/plan/desktop-editor.md format edges
- **Applies:** `slice 3`. **Check:** needs a story and final spec line

### IF09

- **Rule:** Trailing whitespace stays visible outside emphasis until later input can join the span.
- **Why / history:** !1 fixed raw markers left by trailing-space bold/italic/strike; CommonMark flanking must not lose spaces or neighboring letters.
- **Evidence:** !1; !363; portable-core/interpretation-and-input.md
- **Applies:** `slice 3`. **Check:** tests/inline/typed_delimiters.rs; needs a desktop edge-space story

### IF10

- **Rule:** A formatting edit preserves unselected nested and adjacent spans.
- **Why / history:** !629 folded partial-link and soft-line fixes; earlier serializer attention encoding also emitted malformed entities.
- **Evidence:** !629; !384; tests/links/commands.rs
- **Applies:** `slice 3`. **Check:** tests/inline.rs; needs a nested-format desktop story

### IF11

- **Rule:** Removing Code preserves the literal text it revealed rather than activating its Markdown punctuation.
- **Why / history:** Turning Code off around tables, list markers or headings previously changed structure; conversion may still encode literal punctuation.
- **Evidence:** !619; !628; portable-core/fenced-code.md
- **Applies:** `slice 6`. **Check:** tests/fences/commands.rs; README typed-Markdown decision distinguishes command spelling from typing

### IF12

- **Rule:** A delete at a carried-format caret retains that format for the next character.
- **Why / history:** Backspacing a keyboard-inserted period/space must not silently end italic or strike.
- **Evidence:** portable-core/interpretation-and-input.md; tests/inline.rs
- **Applies:** `slice 3`. **Check:** needs a desktop delete-and-continue story
