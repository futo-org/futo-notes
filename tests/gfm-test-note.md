# GFM Syntax Test Note

Canonical manual Markdown fixture for editor syntax and styling checks.
Use this when spot-checking changes to Markdown rendering, cursor reveal, or
theme CSS. Automated coverage lives in `markdown-spec/cases/` and the
Playwright specs; this file is intentionally a human-readable broad sample.

## ATX Headings (1-6 levels)

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

## Paragraphs and Line Breaks

This is a paragraph with
a soft line break (just a newline).

This paragraph ends with two spaces
to create a hard line break.

This paragraph ends with a backslash\
to create a hard line break.

## Thematic Breaks

---

## Emphasis and Strong Emphasis

*italic text*

**bold text**

***bold and italic***

**bold with *nested italic* inside**

## Strikethrough (GFM Extension)

~~This text is struck through~~

~~strikethrough with **bold** inside~~

## Code Spans

Use `inline code` for short snippets.

Use ``backticks ` inside code`` with double backticks.

## Fenced Code Blocks

```
Plain fenced code block
no language specified
```

```javascript
// With language identifier
function hello() {
  console.log("Hello, world!");
}
```

```python
# Python example
def hello():
    print("Hello, world!")
```

## Block Quotes

> This is a block quote.
> It can span multiple lines.

> Block quotes can contain
>
> multiple paragraphs.

> Nested block quotes:
>
> > This is nested one level.
> >
> > > This is nested two levels.

> Block quotes can contain other elements:
>
> - Lists
> - **Bold text**
> - `code`

## Lists

### Unordered Lists

- Item one
- Item two
  - Nested item
  - Another nested item
    - Deeply nested

### Ordered Lists

1. First item
2. Second item
3. Third item
   1. Nested ordered
   2. Another nested

### Mixed Lists

1. Ordered item
   - Unordered nested
   - Another unordered
2. Back to ordered
   1. Nested ordered
   2. Another nested

### Loose vs Tight Lists

- Tight list item 1
- Tight list item 2
- Tight list item 3

- Loose list item 1

- Loose list item 2

- Loose list item 3

## Task Lists (GFM Extension)

- [x] Completed task
- [x] Another completed task
- [ ] Incomplete task
- [ ] Another incomplete task

1. [x] Ordered task list
2. [ ] Also works with numbers

## Links

[Basic link](https://example.com)

[Link with *emphasis*](https://example.com)

## Images

![Alt text](https://futo.org/images/authors/futologo.png "Image Title")

## Tables (GFM Extension)

| Left | Center | Right |
|:-----|:------:|------:|
| L1   |   C1   |    R1 |
| L2   |   C2   |    R2 |
| L3   |   C3   |    R3 |

Table with inline formatting:

| Feature | Supported |
|---------|-----------|
| **Bold** | Yes |
| *Italic* | Yes |
| `Code` | Yes |
| ~~Strike~~ | Yes |
| [Links](https://example.com) | Yes |

Escaped pipes:

| Expression | Result |
|------------|--------|
| `a \| b`   | a \| b |

## Backslash Escapes

\*not italic\*

\`not code\`

\# not a heading

\[not a link\](https://example.com)

\- not a list item

\| not \| a \| table \|

## Edge Cases

### Nested Formatting

**bold *bold-italic* bold**

*italic **italic-bold** italic*

### Code in Lists

- Item with `inline code`
- Item with block:
  ```
  code block in list
  ```

### Links in Tables

| Name | Link |
|------|------|
| Example | [Click](https://example.com) |

### Wide Tables

| Short | This is a very long cell that contains a lot of text to test how tables handle overflow |
|-------|-----------------------------------------------------------------------------------------|
| A     | B                                                                                       |

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 | 7 |

## Visual QA Checklist

- Heading levels should be visually distinct without clipping or overlap.
- Inline styles should remain readable in light and dark themes.
- Code blocks, blockquotes, lists, task items, tables, and horizontal rules
  should keep stable spacing while scrolling.
- Long links, long code lines, and wide tables should not break the editor
  layout on narrow or wide viewports.
