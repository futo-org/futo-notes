# Markdown fidelity

### MD01

- **Rule:** Typed Markdown markers are never silently rewritten as backslash-escaped lookalikes.
- **Why / history:** Mason, 2026-11-10 explicitly rejects the old behavior as a reason for replacement; current engine fallback contradicts this decision.
- **Evidence:** Maintainer decision, 2026-11-10; 28a0ba971 (android-text-first); 29e0f67b9 (android-text-first); portable-core/interpretation-and-input.md
- **Applies:** `desktop now`, once the engine branch `mason/source-preserving-markdown` lands (it owns the change). **Check:** needs a spec line and a desktop source-byte story then; see docs/plan/desktop-editor.md "Source-preserving formatting"

### MD02

- **Rule:** Opening preserves exact source and edits preserve bytes outside the necessary footprint.
- **Why / history:** The 2026-08-27 ADR allowed whole-document normalization for Milkdown; #283 and the new desktop return to source ownership.
- **Evidence:** docs/adr/0002-roundtrip-normalization-accepted.md; #283; portable-core/interpretation-and-input.md
- **Applies:** `desktop now`. **Check:** tests/inline/correspondence.rs; tests/foreign.rs; needs raw-note desktop story

### MD03

- **Rule:** Untouched line endings, trailing spaces and original marker choices survive local edits.
- **Why / history:** The engine differs deliberately from Milkdown's LF-only whole-note house style; authored saves may still add the required final ending.
- **Evidence:** portable-core/interpretation-and-input.md; markdown-house-style.md
- **Applies:** `desktop now`. **Check:** tests/paragraphs/crlf.rs; tests/clipboard.rs; README save-style decision

### MD04

- **Rule:** Enter writes exactly one physical newline and Shift+Enter has the same paragraph meaning.
- **Why / history:** Mason's #263 decision and !394 replace blank-paragraph or hardbreak insertion; two Enters create a paragraph break.
- **Evidence:** #263; !394; paragraphs-and-lines.md
- **Applies:** `desktop now`. **Check:** tests/paragraphs.rs; desktop stories

### MD05

- **Rule:** Backspace or Delete at a line boundary removes one newline and joins visible text predictably.
- **Why / history:** The key must reverse one Enter rather than silently lift a heading/list or leave a hidden empty paragraph.
- **Evidence:** paragraphs-and-lines.md; portable-core/interpretation-and-input.md
- **Applies:** `desktop now`. **Check:** tests/paragraphs.rs; heading/list variants in HG02/LQ04

### MD06

- **Rule:** Code, front matter and authored unknown fields are never normalized through prose spelling.
- **Why / history:** !246 records fence-info loss; !371 preserves definitions and metadata; the engine keeps opaque code bytes.
- **Evidence:** #246; !371; portable-core/fenced-code.md; portable-core/foreign-content.md
- **Applies:** `slice 6`. **Check:** tests/fences.rs; tests/foreign.rs

### MD07

- **Rule:** Formatting output reparses to the same visible text and semantics without malformed entities.
- **Why / history:** !363's flanking fix regressed to &#xNAN; in !384; a valid-looking character reference alone is not proof of fidelity.
- **Evidence:** !363; !384; portable-core/interpretation-and-input.md
- **Applies:** `slice 3`. **Check:** tests/inline/entities.rs; needs stacked-format source/reopen story

### MD08

- **Rule:** Spaces at emphasis edges and paragraph starts remain visible and save back consistently.
- **Why / history:** !477 preserved leading spaces with references; heading/cell/trailing normalization is a different old-serializer rule.
- **Evidence:** !477; markdown-house-style.md; portable-core/clipboard.md
- **Applies:** `desktop now`. **Check:** tests/clipboard.rs; tests/inline.rs; needs whitespace source story

### MD09

- **Rule:** Line-start shortcuts convert only their current line and Undo reverses the triggering key.
- **Why / history:** Earlier paragraph lines cannot be swept into a new list, heading or quote; seven hashes and oversized ordered starts remain literal.
- **Evidence:** !448; portable-core/block-commands.md; portable-core/lists.md
- **Applies:** `slice 3`. **Check:** tests/blocks/conversions.rs; tests/lists/input.rs

### MD10

- **Rule:** Typed and pasted link syntax keep their deliberately different policies until Mason explicitly replaces that decision.
- **Why / history:** !448 keeps hand-typed `[text](url)` literal; pasted Markdown is interpreted; this conflicts with an unrestricted read-as-typed policy.
- **Evidence:** !448; external-links.md; d7120bda1
- **Applies:** `slice 5`. **Check:** needs a spec line resolving this with MD01; do not silently pick a policy

### MD11

- **Rule:** Saving the same document a second time is stable and never grows escaping exponentially.
- **Why / history:** !363 fixed autolink backslashes doubling each save; !394's owned serializer is idempotence-gated.
- **Evidence:** !363; !394; markdown-house-style.md
- **Applies:** `desktop now`. **Check:** needs edit/save/reopen/save exact-byte story

### MD12

- **Rule:** A source-level relink preserves the note's original encoding rather than serializing the whole document.
- **Why / history:** !362 moves canonical wikilink rewriting through the text-level owner and adopts its result once.
- **Evidence:** !362; portable-core/links.md
- **Applies:** `slice 8`. **Check:** needs self-link rename and unrelated-byte preservation story

### MD13

- **Rule:** A new list or divider uses the smallest valid Markdown spelling and never a hidden application-only separator.
- **Why / history:** !625 reverses inserted comment delimiters; divider spelling may use *** to avoid setext/front-matter ambiguity.
- **Evidence:** !625; !632; portable-core/block-commands.md
- **Applies:** `slice 4`. **Check:** needs a source-byte story; stale local comment spec is not final authority

### MD14

- **Rule:** Milkdown's fixed house spellings remain historical compatibility evidence rather than a rule to rewrite desktop notes wholesale.
- **Why / history:** The old writer chose ATX, asterisk emphasis, tilde strike, dash tasks, LF, one terminal newline and per-cell escaping; the new source engine retains originals.
- **Evidence:** markdown-house-style.md; !394; docs/plan/desktop-editor.md
- **Applies:** `obsolete`. **Check:** Use house-style goldens for meaning, not exact whole-note desktop normalization

### MD15

- **Rule:** Authored interior and leading blank lines retain their visible spacing after edit, save and reopen.
- **Why / history:** Milkdown's empty paragraphs originally wrote standalone HTML breaks; the owned writer instead writes blank lines and preserves gaps across chunk seams. The new engine retains untouched source rather than repeating whole-document normalization.
- **Evidence:** docs/spec/editor/wysiwyg-rendering.md; markdown-house-style.md; !394.
- **Applies:** `desktop now`. **Check:** needs leading/interior-gap and older standalone-break compatibility stories.
