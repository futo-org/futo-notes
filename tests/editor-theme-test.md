# Editor Theme CSS Test Document

This document is designed to comprehensively test all markdown elements and verify the visual styling created in `editor-theme.css`.

---

## Heading Hierarchy Test

### All Six Heading Levels Should Be Visually Distinct

# Heading 1 - Largest
## Heading 2 - Large
### Heading 3 - Medium
#### Heading 4 - Small
##### Heading 5 - Smaller
###### Heading 6 - Smallest

Expected: Each level progressively smaller, h1 and h2 have bottom borders, h5/h6 are uppercase.

---

## Inline Formatting Test

### Basic Emphasis

This text is *italic* and this is **bold** and this is ***bold italic***.

This text uses _underscores for italic_ and __underscores for bold__ and ___both___.

Expected: Italic is slanted, bold is heavier weight, bold-italic combines both.

### Strikethrough

This text is ~~struck through~~ and shows a line through it.

Strikethrough with **bold inside**: ~~**bold text**~~

Expected: Line through the text, gray color, not too harsh.

### Inline Code

Use `inline code` for short snippets.

You can have `code with spaces` and `code-with-dashes`.

Use ``double backticks ` inside`` when needed.

Expected: Monospace font, light background, subtle border, inline with text.

### Links

[Basic link to example](https://example.com)

[Link with *emphasis inside*](https://example.com)

[Link with **bold inside**](https://example.com)

Expected: Blue or accent color, underline, clickable appearance, works with nested formatting.

---

## Block Elements Test

### Paragraphs

This is a normal paragraph with regular line height and spacing.

This paragraph has text that wraps naturally and should maintain good readability on all screen sizes.

Multiple paragraphs should have clear spacing between them for visual separation.

Expected: Consistent line height (1.6), good margin between paragraphs, readable width.

### Blockquotes

> This is a simple block quote.
> It can span multiple lines.

Expected: Left border (burgundy), padding-left, muted text color, subtle background.

### Nested Blockquotes

> This is a level 1 quote.
>
> > This is a nested quote.
> >
> > > This is double nested.

Expected: Each level has left border with different styling, clearly nested visually.

### Blockquote with Multiple Elements

> A quote with multiple paragraphs.
>
> And a second paragraph here.
>
> - List inside quote
> - Another item
> - **Bold text** inside quote
> - `code` inside quote

Expected: All nested elements properly styled and readable within quote context.

---

## Code Blocks Test

```
Plain code block without language
No highlighting expected
Just monospace rendering
```

```javascript
// JavaScript example
function greet(name) {
  console.log(`Hello, ${name}!`);
  return true;
}
```

```python
# Python example
def greet(name):
    print(f"Hello, {name}!")
    return True
```

```
Long code block test
Let's make sure that overflow handling works correctly
And that scrolling is available on mobile devices
This line is intentionally long: const veryLongVariableNameThatShouldNotBreakTheLayout = "this is a very long string value";
```

Expected: Monospace font, light background, visible borders, scrollable on overflow, padding inside.

---

## Lists Test

### Unordered Lists

- Simple item 1
- Simple item 2
- Simple item 3

Expected: Bullet points, proper indentation, consistent spacing.

### Nested Unordered Lists

- Top level item 1
  - Nested item 1.1
  - Nested item 1.2
    - Deeply nested item 1.2.1
    - Deeply nested item 1.2.2
  - Nested item 1.3
- Top level item 2

Expected: Each nesting level indented by 24px, visual hierarchy clear.

### Ordered Lists

1. First item
2. Second item
3. Third item

Expected: Numbers 1, 2, 3 displayed, proper indentation.

### Ordered Lists with Nesting

1. First ordered item
   1. Nested ordered 1.1
   2. Nested ordered 1.2
2. Second ordered item
   - Nested unordered 2.1
   - Nested unordered 2.2
3. Third ordered item

Expected: Mixed list types work correctly, nesting preserved.

### Loose vs Tight Lists

Tight list (items on consecutive lines):
- Item 1
- Item 2
- Item 3

Loose list (items with blank lines):
- Item 1

- Item 2

- Item 3

Expected: Tight lists have less spacing, loose lists have more spacing between items.

### List with Multiple Paragraphs

- Item with multiple paragraphs

  This is a second paragraph in the same list item.

- Another item

Expected: Paragraphs within list items properly spaced and indented.

---

## Task Lists Test

### Task List Items

- [x] Completed task 1
- [x] Completed task 2
- [ ] Incomplete task 1
- [ ] Incomplete task 2

Expected: Checkboxes visible, checked items with checkmark and filled background, completed text may be struck through.

### Mixed Task and Regular Items

- [x] Task 1 completed
- Regular item 1
- [ ] Task 2 not done
- Regular item 2

Expected: Tasks and regular items mixed correctly.

### Ordered Task Lists

1. [x] Completed ordered task
2. [ ] Incomplete ordered task
3. [x] Another completed

Expected: Numbered tasks with checkboxes, numbering preserved.

---

## Horizontal Rules Test

Text before the rule.

---

Text after the rule.

More text here with another rule:

***

And one more style:

___

Expected: Clear horizontal line visible, good spacing above and below, multiple styles work.

---

## Tables Test

### Basic Table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| A1       | A2       | A3       |
| B1       | B2       | B3       |
| C1       | C2       | C3       |

Expected: Clear borders, cell padding, header row distinct.

### Table with Alignment

| Left Aligned | Center Aligned | Right Aligned |
|:-------------|:--------------:|---------------:|
| Left 1       | Center 1       | Right 1       |
| Left 2       | Center 2       | Right 2       |
| Left 3       | Center 3       | Right 3       |

Expected: Columns aligned according to alignment markers, text positioned correctly.

### Table with Inline Formatting

| Feature | Status | Notes |
|---------|--------|-------|
| **Bold** | ✓ | Works in tables |
| *Italic* | ✓ | Works in tables |
| `Code` | ✓ | Monospace rendering |
| ~~Strikethrough~~ | ✓ | Line through |
| [Links](https://example.com) | ✓ | Clickable |

Expected: All inline formatting works within table cells, readability maintained.

### Wide Table with Many Columns

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| Very long content that takes up more space | More text | Data | Data | Data | Data | Data | Data |

Expected: Horizontal scrolling on mobile, table remains readable, no layout breaking.

### Minimal Table

| Header 1 | Header 2 |
|----------|----------|
| Data 1   | Data 2   |

Expected: Simplest table format works correctly.

---

## Complex Nested Formatting

### Bold with Nested Italic

**This is bold text with *italic inside it* and back to bold.**

Expected: Bold outer, italic portions slanted, seamless transition.

### Italic with Nested Bold

*This is italic text with **bold inside it** and back to italic.*

Expected: Italic outer, bold portions heavier, seamless transition.

### Bold, Italic, and Code

This text has **bold**, *italic*, and `code` all in one sentence.

Expected: All three formatting types clearly distinct and readable.

### Code Inside Blockquote

> This quote mentions `inline code` and references a concept.
>
> Here's a code block in a quote:
> ```
> function demo() {}
> ```

Expected: Code styling works within blockquote context, maintains readability.

### Code in Lists

- Item with `inline code`
- Item with a code block:
  ```
  code block in list
  ```
- Back to normal items

Expected: Code elements properly indented within list, styles preserved.

### Links in Various Contexts

Normal link: [example.com](https://example.com)

Link in bold: **[link](https://example.com)**

Link in italic: *[link](https://example.com)*

Link in blockquote: > See [this resource](https://example.com)

Expected: Links remain clickable and styled in all contexts.

---

## Edge Cases and Stress Tests

### Very Long Line

This is a very long line of text that should wrap naturally without breaking the layout. It should maintain readability and not cause any overflow issues. The text should continue on the next line seamlessly without any visual artifacts or layout problems that would negatively impact the user experience when viewing this note.

Expected: Text wraps naturally, no horizontal scroll, proper word breaking.

### Long URL in Link

[This link has a very long URL that might cause issues on mobile](https://example.com/very/long/path/structure/that/could/potentially/break/layouts/if/not/handled/correctly)

Expected: Link text wraps correctly, doesn't break layout, remains clickable.

### Code Block with Long Lines

```
This is a line with a lot of code that goes on and on and on without any spaces or line breaks: var veryLongVariableNameWithoutBreaks = "this should scroll horizontally";
```

Expected: Horizontal scrolling on overflow, preserves code formatting.

### Mixed List Types

1. Ordered item
   - Unordered nested
     1. Ordered inside unordered
        - Unordered inside that
     2. Another ordered
   - Back to unordered
2. Back to ordered

Expected: All nesting levels work correctly, indentation preserved.

### Empty Block Elements

Empty blockquote:
>

Empty list items:
-
- Non-empty

Expected: Empty elements don't break layout, handled gracefully.

### Multiple Spaces and Special Formatting

Text   with   extra   spaces   should   still   render.

Expected: Extra spaces collapse to single space (HTML behavior), text readable.

### Emphasis Next to Code

**bold**`code`*italic*

Expected: Elements separated correctly, no visual bleeding between them.

---

## Responsive Design Test Notes

Test on these screen sizes:

### Mobile (375px width)
- All text readable without zoom
- Headings appropriately sized
- Lists properly indented but not excessive
- Tables scroll horizontally if needed
- Code blocks are scrollable
- Links are easily tappable (at least 44px touch target)

### Tablet (800px width)
- Comfortable reading width
- Code blocks fit without scrolling where possible
- Tables displayed clearly
- Good spacing maintained

### Desktop (1200px width)
- Max-width constraint applied (around 900px)
- Centered content with margins
- All elements have room to breathe
- Tables fully visible without scroll

---

## Color Palette Reference

Used in editor-theme.css:

### Primary Colors
- **Background**: `#FAF9F6` - Warm paper tone
- **Text Primary**: `#2C2C2C` - Soft black
- **Text Secondary**: `#5C5C5C` - Medium gray
- **Text Tertiary**: `#8A8A8A` - Light gray
- **Text Muted**: `#AEAEAE` - Very light gray

### Accents
- **Accent**: `#3D5A80` - Muted slate blue (links)
- **Accent Light**: `#4A6FA5` - Lighter slate blue (hover)
- **Emphasis**: `#8B2635` - Deep burgundy (blockquotes)
- **Success**: `#4A7C59` - Muted forest green

### Surfaces & Borders
- **Code Background**: `#F4F1EC` - Inline code
- **Code Block Background**: `#EBE7E0` - Code blocks
- **Border**: `#E8E4DE` - Subtle warm border
- **Border Light**: `#F0EDE8` - Light border
- **Separator**: `#DDD8D0` - Line separators

---

## Visual Testing Checklist

- [ ] All 6 heading levels visually distinct and properly sized
- [ ] Bold text clearly bolder than normal
- [ ] Italic text clearly slanted
- [ ] Strikethrough has visible line through text
- [ ] Inline code is monospace with background
- [ ] Links are colored and underlined
- [ ] Blockquotes have left border and distinct styling
- [ ] Nested blockquotes show clear hierarchy
- [ ] Code blocks are monospace with background and scrollable
- [ ] Lists have proper bullets and indentation
- [ ] Nested lists show clear hierarchy
- [ ] Task checkboxes visible (checked/unchecked)
- [ ] Completed tasks may show strikethrough
- [ ] Horizontal rules visible as thin lines
- [ ] Tables have borders and clear structure
- [ ] Table cells properly padded
- [ ] Table alignment respected (left/center/right)
- [ ] Wide tables scroll horizontally
- [ ] Nested formatting combinations work
- [ ] Mobile responsive (375px): all content readable, properly spaced
- [ ] Tablet responsive (800px): comfortable viewing
- [ ] Desktop responsive (1200px): max-width applied, centered
- [ ] No layout breaking or overflow issues
- [ ] Colors follow "quiet luxury" palette
- [ ] Contrast is sufficient for readability
- [ ] Print styles work (optional)

---

## Notes for Future Enhancements

1. **Dark Mode**: The CSS has a placeholder for dark mode styles. Recommended colors:
   - Background: `#1A1A1A`
   - Text: `#E8E8E8`
   - Accents: `#7B9FBF` (muted blue)
   - Emphasis: `#D97777` (muted red)

2. **Syntax Highlighting for Code Blocks**: Currently using monospace only. Could add:
   - Language-specific syntax highlighting
   - Line numbers
   - Diff highlighting for code diffs

3. **Accessibility**: Could add:
   - Focus states for keyboard navigation
   - ARIA labels for interactive elements
   - High contrast mode support

4. **Custom Fonts**: Currently using system fonts. Could integrate:
   - Vollkorn (serif) for headings
   - IBM Plex Sans (body)
   - IBM Plex Mono (code)

5. **Animation**: Subtle animations could enhance:
   - Link hover effects
   - Task checkbox interactions
   - Blockquote emphasis on hover
