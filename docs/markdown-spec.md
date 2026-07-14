# FUTO Notes Markdown Specification

This document defines every markdown feature FUTO Notes supports, how it renders in the editor, and how the server processes it. It serves as the authoritative reference for contributors, AI agents, and test authors.

FUTO Notes uses CodeMirror 6's `@codemirror/lang-markdown` for parsing. The custom rendering layer (`liveMarkdownTransform.ts`) decorates the parsed syntax tree with CSS classes, hides syntax markers, and renders widgets. This spec documents the **decoration behavior**, not the parsing rules (which are CM6's responsibility).

## Core Concept: Cursor-Reveal

All markdown syntax markers are hidden when the editor is **blurred** (no focus). When the editor is **focused**, markers are revealed on the **current cursor line** only. Other lines remain clean. This is the fundamental UX pattern — the spec calls it "cursor-reveal."

- **Block elements** (headings, lists, code blocks, blockquotes, horizontal rules): Revealed when cursor is on the same line.
- **Inline elements** (emphasis, strong, inline code, links, images, strikethrough, tasks): Revealed when cursor is inside the element's character range.
- **Wikilinks and tags**: Revealed when cursor is on the same line.

---

## 1. Headings

**Syntax**: `# ` through `###### ` (ATX headings, 1-6 levels)

**Decoration behavior**:
- Marker (`# ` including trailing space) gets class `Decoration.replace` (hidden via `display: none`)
- Content text gets class `cm-md-h{N}` where N is the heading level (1-6)
- Content also gets `data-heading-level="{N}"` attribute

**Styling**:
| Level | Font | Size | Weight | Color |
|-------|------|------|--------|-------|
| H1 | `--font-serif` | 32px (28px mobile) | 700 | `--color-text` |
| H2 | `--font-serif` | 26px (22px mobile) | 700 | `--color-text` |
| H3 | `--font-serif` | 22px (19px mobile) | 700 | `--color-text` |
| H4 | `--font-sans` | 18px | 600 | `--color-text` |
| H5 | `--font-sans` | 16px | 600 | `--color-muted` |
| H6 | `--font-sans` | 14px | 600 | `--color-muted` |

**Cursor-reveal**: Block element — markers shown (in `--color-border`) when cursor is on the heading line. CSS uses `.cm-editor:focus-within .cm-md-h{N} .cm-md-h{N}-marker` selectors.

**Not supported**: Setext headings (`===` / `---` underlines).

---

## 2. Emphasis

### 2a. Italic

**Syntax**: `*text*`

**Decoration behavior**:
- Opening `*` → `Decoration.replace`
- Closing `*` → `Decoration.replace`
- Content → `cm-md-emphasis`

**Styling**: `font-style: italic; color: inherit`

### 2b. Bold

**Syntax**: `**text**`

**Decoration behavior**:
- Opening `**` → `Decoration.replace`
- Closing `**` → `Decoration.replace`
- Content → `cm-md-strong`

**Styling**: `font-weight: 700; color: inherit`

### 2c. Bold-Italic

**Syntax**: `***text***`

CM6 parses this as nested `StrongEmphasis` + `Emphasis`. Both sets of markers are hidden and both classes applied. The result is bold + italic text.

**Cursor-reveal**: Inline element — markers shown when cursor is inside the emphasis span.

---

## 3. Strikethrough

**Syntax**: `~~text~~` (GFM extension)

**Decoration behavior**:
- Opening `~~` → `Decoration.replace`
- Closing `~~` → `Decoration.replace`
- Content → `cm-md-strikethrough`

**Styling**: `text-decoration: line-through; color: --color-muted`

**Cursor-reveal**: Inline element.

---

## 4. Code

### 4a. Inline Code

**Syntax**: `` `text` `` or ` ``text`` ` (double backticks for backtick-containing code)

**Decoration behavior**:
- Opening backtick(s) → `Decoration.replace`
- Closing backtick(s) → `Decoration.replace`
- Entire span (including hidden markers) → `cm-md-code`

**Styling**: Monospace font, 0.88em size, `--color-primary-hover` text, subtle background, 4px border-radius, 2px 6px padding.

**Cursor-reveal**: Inline element.

### 4b. Fenced Code Blocks

**Syntax**: ` ``` ` or `~~~` with optional language identifier

**Decoration behavior**:
- Opening fence line (`` ```javascript ``) → `Decoration.replace`
- Closing fence line (` ``` `) → `Decoration.replace`
- Content lines → line decoration with class `cm-md-code-block` plus position class:
  - Single content line: `cm-md-code-block-single`
  - First content line: `cm-md-code-block-first`
  - Middle content lines: `cm-md-code-block-middle`
  - Last content line: `cm-md-code-block-last`

**Styling**: Monospace font, 0.88em size, subtle background, 2px left border (`--color-border`), 16px horizontal padding (8px top/bottom on first/last lines).

**Cursor-reveal**: Block element — raw fences shown when cursor is on any line of the code block.

---

## 5. Links

**Syntax**: `[text](url)`

**Decoration behavior**:
- Opening `[` → `Decoration.replace`
- Closing `](url)` → `Decoration.replace`
- Link text → `cm-md-link`

**Styling**: `--color-primary` color, solid underline at 35% opacity, 2px offset, pointer cursor. Hover: `--color-primary-hover`, 50% opacity underline.

**Click behavior**: Opens URL via platform `openUrl()`.

**Cursor-reveal**: Inline element.

### Autolinks

**Syntax**: Bare URLs (`https://example.com`, `www.example.com`)

Autolinks are detected via regex matching (not part of CM6 markdown AST). They receive classes `cm-md-link cm-md-autolink`. URLs starting with `www.` are normalized to `https://` on click.

---

## 6. Images

**Syntax**: `![alt](url)` or `![alt](url "title")`

**Decoration behavior**: The entire syntax is **replaced** with an `ImageWidget`:
- Wrapper div: `cm-md-image-wrapper` (8px vertical margin)
- Image element: `cm-md-image-widget` (max-width: 100%, max-height: 300px, 6px border-radius)

**Image handling**:
- Remote URLs (`http://`, `https://`, `data:`) render directly
- Local filenames are resolved via `getImageWebPath()` and cached in `localImageUrlCache`
- Dimensions are preloaded and cached in `imageSizeCache` to prevent layout shift
- Click on image places cursor at end of image line

**Cursor-reveal**: Inline element — raw syntax shown when cursor is inside the image range.

---

## 7. Blockquotes

**Syntax**: `> text` (up to 3 nesting levels)

**Decoration behavior**:
- Quote markers (`> `, `> > `, etc.) → `Decoration.replace` when cursor is NOT on the line
- Quote markers → `cm-md-quote-marker` (dimmed, `--color-border`) when cursor IS on the line
- Each line gets a line decoration with classes:
  - `cm-md-quote` (always)
  - `cm-md-quote-level-{N}` where N = nesting depth (1-3)
  - Position class: `cm-md-quote-first`, `cm-md-quote-middle`, `cm-md-quote-last`, or `cm-md-quote-single`

**Styling**:
- Level 1: 15px left padding, 2px left border in `--color-primary`, italic, `--color-muted`
- Level 2: 30px left padding, two vertical lines via CSS gradients
- Level 3: 45px left padding, three vertical lines via CSS gradients

**Cursor-reveal**: Hybrid — block-level for the marker text (dimmed instead of hidden on cursor line), but the line decoration styling always applies.

---

## 8. Lists

### 8a. Unordered Lists

**Syntax**: `- item`, `* item`, or `+ item`

**Decoration behavior**:
- Bullet marker + space → `Decoration.replace`
- `BulletWidget` inserted at marker position (side: -1)
- Content text → `cm-md-ul-item`
- Line gets `cm-md-list-line` with computed `padding-left` and negative `text-indent` for hanging indent

**Bullet glyphs**: Cycle by indent level: `•` (level 0), `◦` (level 1), `▪` (level 2), then repeat.

**Indent calculation**: `indentLevel = floor(realIndent / 2)`. Each level adds 24px (`INDENT_STEP`). Bullet marker width: 20px.

### 8b. Ordered Lists

**Syntax**: `1. item`, `2. item`, etc.

**Decoration behavior**:
- Number + dot + space → `Decoration.replace`
- `NumberWidget` inserted showing `{N}.` (preserves original numbering)
- Content text → `cm-md-ol-item`
- Line gets `cm-md-list-line` with hanging indent (number marker width: 24px)

### 8c. Task Lists (Unordered)

**Syntax**: `- [ ] unchecked` or `- [x] completed`

**Decoration behavior**:
- Bullet + space + `[x]` + space → `Decoration.replace`
- `TaskCheckboxWidget` inserted (interactive checkbox, 18x18px)
- Content text → `cm-md-task`
- Line gets `cm-md-list-line` (checkbox marker width: 32px)

**Interaction**: Clicking the checkbox toggles `[ ]` ↔ `[x]` in the document. Works without stealing focus if editor wasn't focused.

### 8d. Task Lists (Ordered)

**Syntax**: `1. [ ] unchecked` or `1. [x] completed`

**Decoration behavior**:
- Number + dot + space + `[x]` + space → `Decoration.replace`
- `NumberWidget` + `TaskCheckboxWidget` both inserted
- Content text → `cm-md-task`
- Line gets `cm-md-list-line` (ordered task marker width: 56px)

**Cursor-reveal**: Block element — all list items show raw syntax when cursor is on that line. Indent padding is preserved even on cursor lines to prevent visual jumping.

---

## 9. Tables

**Syntax**: GFM pipe tables

```
| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
```

**Decoration behavior**: When cursor is NOT inside the table, the entire table range is replaced with a `TableWidget` that renders an HTML `<table>`:
- Wrapper: `cm-md-table-wrapper` (scrollable, 8px vertical margin, 8px border-radius)
- Table: `cm-md-table-rendered` (collapsed borders, 0.93em font)
- Headers: `<th>` with `--color-surface` background, 600 weight
- Cells: 10px 14px padding, 1px solid borders
- Even rows: subtle background
- Hover: primary-tinted background

**Alignment**: Supports `:---` (left), `:---:` (center), `---:` (right) via column alignment markers.

**Inline formatting in cells**: Bold, italic, code, links, strikethrough rendered inside cells with dedicated table classes (`cm-md-table-code`, `cm-md-table-link`).

**Escaped pipes**: `\|` inside cells treated as literal pipe, not column separator.

**Cursor-reveal**: When cursor enters the table range, the widget is removed and raw markdown is shown.

---

## 10. Horizontal Rules

**Syntax**: `---`

**Decoration behavior**: The entire line is replaced with an `HorizontalRuleWidget`:
- Wrapper div: `cm-md-hr-widget` (16px vertical margin, flex layout)
- Line: 1px solid `--color-border`

**Cursor-reveal**: Block element.

---

## 11. Wikilinks (FUTO Notes Extension)

**Syntax**: `[[note title]]`

Wikilinks are NOT part of the CM6 markdown syntax tree. They are processed separately via regex: `/\[\[([^\]\n]+)\]\]/g`

**Decoration behavior**:
- Opening `[[` → `Decoration.replace`
- Closing `]]` → `Decoration.replace`
- Title text → `cm-md-link cm-md-wikilink` with `data-wikilink="{title}"` attribute

**Styling**: Same as links but with `text-decoration-style: dashed` (dashed underline distinguishes from regular links).

**Exclusions**: Wikilinks inside code blocks or inline code are NOT decorated (checked via CM6 syntax tree).

**Click behavior**: Navigates to `/note/{encodeURIComponent(title)}`.

**Autocomplete**: Typing `[[` filters the already-loaded note universe, showing matching note titles without starting a second durable search index.

**Cursor-reveal**: Revealed when cursor is on the same line as the wikilink.

---

## 12. Hashtags (FUTO Notes Extension)

**Syntax**: `#tagname`

**Tag rules** (from `@futo-notes/shared`):
- Must start with `#` followed by a letter (`[a-zA-Z]`)
- Then alphanumeric, underscore, or dash: `[a-zA-Z0-9_-]`
- Maximum 50 characters after `#`
- Must be preceded by whitespace or start of line
- Must be followed by whitespace, end of line, or punctuation (`.,;:!?)]`)
- NOT a tag: `#123`, `#`, `example#section`

**Decoration behavior**:
- Full tag (including `#`) → `cm-md-tag`

**Styling**: `--color-primary` color.

**Exclusions**: Tags inside code blocks/inline code are NOT decorated. Tags within the header tag block region are NOT decorated by the inline tag processor (they're handled separately).

### Header Tag Block

A contiguous run of lines at the very start of a note where each line consists only of hashtags and whitespace.

```
#project #important
#status-active

# Actual Heading Starts Here
```

**Decoration behavior**: When cursor is NOT in the header tag block, all tag lines receive the line decoration `cm-header-tag-hidden` (`display: none !important`). When cursor enters any line of the block, all lines become visible.

**Server-side**: `extractHeaderTagBlock()` returns `{ tags: string[], endOffset: number }`. The `endOffset` includes trailing blank line separator.

**Cursor-reveal**: All lines in the block are shown/hidden together (if cursor is on ANY line in the block, all lines are visible).

---

## 13. Server-Side Processing

### 13a. Tag Extraction (`extractTags`)

Uses regex-based extraction (NOT CM6 syntax tree):
1. Strip fenced code block regions (` ``` ` / `~~~`) → replace with spaces (preserve offsets)
2. Strip inline code regions (`` ` ``) → replace with spaces
3. Apply `TAG_REGEX` to extract all tags
4. Deduplicate case-insensitively (first occurrence wins, preserving original casing)
5. Return array with `#` prefix: `["#project", "#important"]`

**Conformance note**: The client uses CM6's syntax tree to detect code regions for tag styling, while the server uses regex. Both must agree on which tags are inside code and which are not.

### 13b. Content Chunking (`chunkContent`)

Splits markdown into chunks for semantic search embeddings:
- **Short notes** (<512 estimated tokens): Single chunk
- **Minimum**: Notes with fewer than 10 words are skipped (empty array)
- **Target**: ~900 tokens per chunk with 15% overlap
- **Boundaries**: Split first at headings (`^#{1-6}\s`), then at paragraphs (`\n\n+`), then by word count as fallback
- **Token estimation**: `words * 1.3`

### 13c. Filename Handling

The filename IS the title. `"grocery list.md"` → title is `"grocery list"`. No case changes, no dash-to-space, no transformations. `sanitizeFilename()` only strips filesystem-breaking characters.

---

## 14. Known Quirks

1. **CM6 CSS layering**: Styles in `@layer(components)` lose to CM6's unlayered CSS. All CodeMirror overrides in `markdown.css` use `!important`.

2. **Composition suspension**: During Android IME composition, all decorations are temporarily removed (`Decoration.none`) to prevent crashes. Decorations rebuild when composition ends.

3. **No Setext headings**: Only ATX headings (`#`) are supported. `===` and `---` under text are not recognized as headings.

4. **Blockquote nesting limit**: CSS only styles up to 3 levels of nesting. Deeper nesting uses level-3 styling.

5. **Heading markers in focus mode**: The CSS cursor-reveal for headings uses a different mechanism than code — it relies on `.cm-md-h{N}-marker` class selectors rather than the decoration rebuild. This means heading markers have a slightly different reveal behavior.

6. **Table cursor detection**: Table widget replacement uses cursor-in-range detection. Moving cursor into a rendered table switches to raw markdown view.

---

## 15. Cross-Feature Interaction Rules

| Combination | Expected Behavior |
|-------------|------------------|
| Wikilink inside blockquote | Both decorated — quote line styling + wikilink hiding/styling |
| Tag inside list item | Both decorated — list bullet/indent + tag coloring |
| Bold inside link | Link markers hidden, bold markers hidden, text gets both `cm-md-link` and `cm-md-strong` |
| Wikilink inside code block | NOT decorated as wikilink (code takes precedence) |
| Tag inside code block | NOT decorated as tag (code takes precedence) |
| Emphasis inside heading | Heading class on outer content, emphasis class on inner span |
| Code block inside blockquote | Both apply — quote line decoration + code block line decoration |
| Image inside list | Image widget replaces syntax, list indent applies |
| Table with formatted cells | Table widget renders inline markdown (bold, italic, code, links, strikethrough) in cells |
| Header tag block + heading | Tag block hidden, heading renders normally below it |
| Multiple wikilinks on one line | All decorated independently |
| Adjacent emphasis `*a* *b*` | Each decorated independently |
