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

### Mode 2: Space-After-Close Transform

Transformation occurs when the user:
1. Completes the closing syntax (e.g., `**`, `*`, `` ` ``, `)`)
2. Presses the space bar

**Applies to:**
- Bold (`**text**` or `__text__`)
- Italic (`*text*` or `_text_`)
- Strikethrough (`~~text~~`)
- Inline code (`` `code` ``)
- Links (`[text](url)`)

**Rationale:** These are inline elements that appear mid-sentence. Waiting for line-exit would be disruptive since users often write multiple inline elements on the same line. The space character serves as a natural delimiter indicating the user has finished the element and is moving to the next word.

## Supported Elements

### Headings (ATXHeading)

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `# text` | `.cm-md-h1` | 1.8em, font-weight: 700 |
| `## text` | `.cm-md-h2` | 1.5em, font-weight: 700 |
| `### text` | `.cm-md-h3` | 1.25em, font-weight: 600 |
| `#### text` | `.cm-md-h4` | 1.1em, font-weight: 600 |
| `##### text` | `.cm-md-h5` | 1em, font-weight: 600 |
| `###### text` | `.cm-md-h6` | 0.9em, font-weight: 600, color: #666 |

**Trigger:** Line-exit  
**Behavior:** Header mark (`#` characters and trailing space) is hidden. Remaining content receives heading styling.

### Bold (StrongEmphasis)

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `**text**` | `.cm-md-strong` | font-weight: 700 |
| `__text__` | `.cm-md-strong` | font-weight: 700 |

**Trigger:** Space after closing `**` or `__`  
**Behavior:** Opening and closing emphasis marks are hidden. Content between marks receives bold styling.

### Italic (Emphasis)

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `*text*` | `.cm-md-emphasis` | font-style: italic |
| `_text_` | `.cm-md-emphasis` | font-style: italic |

**Trigger:** Space after closing `*` or `_`  
**Behavior:** Opening and closing emphasis marks are hidden. Content between marks receives italic styling.

### Strikethrough

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `~~text~~` | `.cm-md-strikethrough` | text-decoration: line-through, color: #888 |

**Trigger:** Space after closing `~~`  
**Behavior:** Opening and closing strikethrough marks are hidden. Content between marks receives strikethrough styling.

### Inline Code

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `` `code` `` | `.cm-md-code` | monospace font, background: #f4f4f4, padding, border-radius |

**Trigger:** Space after closing `` ` ``  
**Behavior:** Opening and closing backticks are hidden. Content between marks receives code styling (monospace font with subtle background).

### Links

| Syntax | CSS Class | Styling |
|--------|-----------|---------|
| `[text](url)` | `.cm-md-link` | color: #007AFF, text-decoration: underline |

**Trigger:** Space after closing `)`  
**Behavior:** All link syntax is hidden (`[`, `]`, `(url)`). Only the link text remains visible with link styling.

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

## Cursor Line Behavior

When the cursor is on a line containing transformed elements, the raw markdown syntax is revealed for editing. This applies to both trigger modes:

- **Line-exit elements:** Raw syntax shown while cursor is anywhere on the line
- **Space-after-close elements:** Raw syntax shown while cursor is within or immediately adjacent to the element

This ensures users can always see and edit the underlying markdown syntax when needed.

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
