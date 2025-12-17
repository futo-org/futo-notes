# Markdown Live Transform Specification

This document specifies the behavior of the live markdown transformation system in FUTO Notes. The system provides a WYSIWYG-like editing experience by hiding markdown syntax characters and applying CSS styling in real-time.

## Overview

The editor uses CodeMirror 6 with a custom `ViewPlugin` that analyzes the markdown syntax tree and applies decorations to:

1. **Hide** markdown syntax characters (e.g., `*`, `#`, `` ` ``)
2. **Style** content with appropriate CSS (e.g., bold, italic, heading sizes)
3. **Replace** certain elements with widgets (e.g., list bullets, checkboxes, horizontal rules)

## Transformation Trigger Modes

There are two distinct trigger modes depending on the element type:

### Mode 1: Line-Exit Transform

Transformation occurs when the cursor leaves the line containing the markdown element.

**Applies to:**
- Headings (H1-H6)
- Blockquotes
- List items
- Task items
- Fenced code blocks
- Horizontal rules

**Rationale:** These are block-level elements where the syntax characters are at the beginning of the line. Users typically finish typing the line content before moving on, making line-exit a natural trigger point.

### Mode 2: Inline Element Transform

Transformation occurs progressively as the user types:

1. **Cursor inside element:** Raw syntax shown (for editing)
2. **Cursor at end of element:** Styling applied, but markers remain visible (preview state)
3. **Cursor moved away:** Full transformation (styling applied, markers hidden)

**Applies to:**
- Bold (`**text**` or `__text__`)
- Italic (`*text*` or `_text_`)
- Strikethrough (`~~text~~`)
- Inline code (`` `code` ``)
- Links (`[text](url)`)

**Rationale:** These are inline elements that appear mid-sentence. The progressive reveal allows users to see the styled result immediately after completing the syntax, while keeping markers visible until they continue typing. This provides visual feedback that the syntax is valid before fully hiding the markers.

## Supported Elements

### Headings (ATXHeading)

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `# text` | `.cm-md-h1` | 1.8em |
| `## text` | `.cm-md-h2` | 1.5em |
| `### text` | `.cm-md-h3` | 1.25em |
| `#### text` | `.cm-md-h4` | 1.1em |
| `##### text` | `.cm-md-h5` | 1em |
| `###### text` | `.cm-md-h6` | 0.9em, color: #666 |

**Trigger:** Line-exit  
**Behavior:** Header mark (`#` characters and trailing space) is hidden. Remaining content receives heading styling.

### Bold (StrongEmphasis)

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `**text**` | `.cm-md-strong` | font-weight: 700 |
| `__text__` | `.cm-md-strong` | font-weight: 700 |

**Trigger:** Inline element transform
**Behavior:** Content between marks receives bold styling. Markers hidden when cursor moves away.

### Italic (Emphasis)

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `*text*` | `.cm-md-emphasis` | font-style: italic |
| `_text_` | `.cm-md-emphasis` | font-style: italic |

**Trigger:** Inline element transform
**Behavior:** Content between marks receives italic styling. Markers hidden when cursor moves away.

### Strikethrough

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `~~text~~` | `.cm-md-strikethrough` | text-decoration: line-through, color: #888 |

**Trigger:** Inline element transform
**Behavior:** Content between marks receives strikethrough styling. Markers hidden when cursor moves away.

### Inline Code

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `` `code` `` | `.cm-md-code` | monospace font, background: #f4f4f4, padding, border-radius |

**Trigger:** Inline element transform
**Behavior:** Content between marks receives code styling (monospace font with subtle background). Backticks hidden when cursor moves away.

### Links

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `[text](url)` | `.cm-md-link` | color: #007AFF, text-decoration: underline |

**Trigger:** Inline element transform
**Behavior:** Link text receives link styling (blue, underlined). All syntax (`[`, `]`, `(url)`) hidden when cursor moves away.

### Blockquotes

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `> text` | `.cm-md-blockquote` | left border, padding-left, color: #666, italic |

**Trigger:** Line-exit  
**Behavior:** Quote mark (`>` and trailing space) is hidden. Entire block receives blockquote styling.

### List Items

| Syntax | Rendered As |
|--------|-------------|
| `- item` | `• item` |
| `* item` | `• item` |
| `+ item` | `• item` |
| `1. item` | `• item` |

**Trigger:** Line-exit  
**Behavior:** List mark is replaced with a bullet widget (`•`).

### Task Items

| Syntax | Rendered As | Additional Styling |
|--------|-------------|-------------------|
| `- [ ] task` | `☐ task` | None |
| `- [x] task` | `☑ task` | `.cm-md-task-checked` (strikethrough, gray) |

**Trigger:** Line-exit  
**Behavior:** Task marker is replaced with checkbox widget. Checked items receive additional strikethrough styling.

### Fenced Code Blocks

~~~
```language
code
```
~~~

**Trigger:** Line-exit  
**Behavior:** Opening fence (and optional language identifier) and closing fence are hidden. Entire block receives `.cm-md-codeblock` styling (monospace, background).

### Horizontal Rules

| Syntax | Rendered As |
|--------|-------------|
| `---` | Visual horizontal line |
| `***` | Visual horizontal line |
| `___` | Visual horizontal line |

**Trigger:** Line-exit  
**Behavior:** Entire syntax is replaced with a styled `<div>` widget rendering as a horizontal line.

## Cursor Behavior

### Block Elements (Line-Exit)

Raw syntax shown while cursor is anywhere on the line. When cursor leaves the line, full transformation is applied.

### Inline Elements

Three states based on cursor position:

| Cursor Position | Styling | Markers |
|-----------------|---------|---------|
| Inside element (`**wo\|rd**`) | None | Visible |
| At end of element (`**word**\|`) | Applied | Visible |
| Moved away (`**word**X\|`) | Applied | Hidden |

This progressive reveal provides immediate visual feedback when syntax is complete, while keeping markers visible until the user continues typing.

**Example flow:**
1. Type `**bold` — raw text, no transformation
2. Type `**` — completes syntax, cursor at `**bold**|`, shows **bold** with visible `**`
3. Type `,` — cursor at `**bold**,|`, shows **bold**, (markers hidden)
4. Click inside "bold" — reveals `**bold**` for editing

## Implementation Notes

### Syntax Tree

The system uses CodeMirror's `@lezer/markdown` parser to build a syntax tree. Key node types:

- `ATXHeading1` through `ATXHeading6`
- `Emphasis`, `StrongEmphasis`
- `Strikethrough` (via GFM extension)
- `InlineCode`
- `Link`, `LinkLabel`, `URL`
- `Blockquote`, `QuoteMark`
- `ListItem`, `ListMark`
- `Task`, `TaskMarker`
- `FencedCode`, `CodeMark`, `CodeInfo`
- `HorizontalRule`

### Decoration Types

1. `Decoration.replace({})` - Hides content entirely
2. `Decoration.replace({ widget })` - Replaces content with a widget
3. `Decoration.mark({ class })` - Applies CSS class to content range

### Update Triggers

The decoration plugin rebuilds when:
- Document content changes (`docChanged`)
- Viewport scrolls (`viewportChanged`)
- Selection changes (`selectionSet`)
- Focus state changes (`focusChanged`)

### Performance

- Only visible ranges are processed (viewport optimization)
- Syntax tree parsing has a timeout to prevent blocking
- Decorations are sorted and built as a single `RangeSet`
