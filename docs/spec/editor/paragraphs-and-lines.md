## Paragraphs and lines

- Enter is a newline. Inside a paragraph, Enter puts the caret on a new line and
  writes exactly one newline to the file — no blank line, no trailing spaces, no
  backslash, no HTML. Shift+Enter is the same key everywhere but a table cell,
  and the on-screen keyboard's return key is the same key on iOS and Android. →
  src/features/editor/milkdown/paragraphLines.ts `enterInParagraph`,
  src/features/editor/milkdown/keyboardParity.ts,
  tests/editor-embed-milkdown-interactive.spec.ts
- Enter on an empty line ends the paragraph: two Enters write one blank line. A
  third Enter leaves an empty paragraph, the extra blank line above. Enter at
  the very start of a line splits the paragraph there the same way, because a
  blank line inside a paragraph is a paragraph break in the file.
- A file whose lines are separated by single newlines opens with those lines
  shown one under the other, and opening it does not rewrite it. An older
  note's `\` or two-space hard break also opens as a line break.
- Backspace at the start of a line joins it to the line above. At the start of
  a paragraph that follows another paragraph it removes ONE newline, so the two
  become lines of one paragraph again: Backspace takes back exactly one Enter.
  Delete at the end of a paragraph does the same forwards. When the paragraph
  above already ends in an empty line (an Enter at its end), the next one joins
  onto that line, so a join never leaves an empty line inside a paragraph. →
  paragraphLines.ts `joinBackwardAsLine` / `joinForwardAsLine`
- Delete at the start of the text of a list item or a heading removes the next character, as
  in a paragraph. It never lifts the item out of its list or changes the heading's level. →
  milkdown/keyboardParity.ts `keepDeleteForward`
- Formatting typed across an Enter stays one run: bold carried over a newline
  saves as one `**…**` spanning both lines. Undo after an Enter takes back
  exactly that newline.
- Lists, headings, blockquotes, code blocks and table cells keep their own
  Enter: a list item continues the list, a heading starts a paragraph after it,
  a quote or a code block takes the new line inside it, and a table cell moves
  down a row (Shift+Enter there is an in-cell line break). Shift+Enter in any of
  them does what Enter does.
- Enter at the very start of a quote's first line leaves an empty line ABOVE
  the quote (the outermost one that line starts) and the text still quoted, as
  Enter at the start of a heading or list item leaves one above it: an empty
  line at the start of a quote is not written (Markdown house style), so one
  left inside it would vanish on reopen. `> ab` with the caret before `a`
  saves `\n> ab`. → paragraphLines.ts `enterAtQuoteStart`,
  tests/editor-embed-milkdown-interactive-quote-start.spec.ts
- A code block inside a list item takes Enter as a new line inside it, on its last line too; it
  never closes the fence or starts a new list item. → milkdown/keyboardParity.ts
  `handleParityKeyDown`
- A block shortcut typed at the start of a line — `- `, `1. `, `> `, `# `,
  ` ``` `, `---`, `|2x3| ` (a table) — starts that block from that line alone;
  the lines above stay a paragraph. A block format from the toolbar or the `/`
  menu lands the same way, on the lines the caret or selection touches, each
  becoming its own block. → paragraphLines.ts `handleLineStartShortcut` /
  `isolateSelectedLines`, paragraphLines.preset.test.ts (the shortcut list
  checked against the presets)
- Plain text pasted into a line (a paste with no rich text) is read as
  markdown, but the characters it puts in the line are the ones copied: a space
  or tab at either end of the paste is kept, so `hello` + a pasted ` world`
  saves `hello world` — at the end of a copied line, before its line ending,
  too (`x ` + newline pasted into `ab|cd` saves `abx cd`). →
  src/features/editor/milkdown/plainTextPaste.ts,
  tests/editor-embed-milkdown-interactive-paragraph-lines.spec.ts
- A tab or a run of spaces inside pasted plain text is kept as it was copied,
  never collapsed to one space. → plainTextPaste.ts `parsePasted`
- A block pasted as plain text into a line (`# Title`, a list, a quote, a
  fence, a table) lands as that block. On an empty line it takes the line;
  after text it splits the line at the caret and takes a line of its own, and
  the text on either side stays what it was (a paragraph, or a heading:
  `## Head` + `# Title` saves the two headings). Pasted paragraphs before or
  after the block run on into the text at the caret, as typing them would. →
  plainTextPaste.ts `placeBlocks`
- A block marker pasted alone into a line (`#`, `-`, `*`, `>`, `1.`, `- [ ]`)
  goes in as the characters copied and the line stays whole: `#` pasted into
  `ab|cd` saves `ab#cd`, not `ab`, an empty heading and `cd`. A marker with text
  after it is that block (`1986. A great year` pasted into `ab|cd` is an ordered
  list starting at 1986, between `ab` and `cd`), and so is a divider (`---`).
  One copied line that starts with a tab or four spaces is the same: its
  whitespace is kept as copied, not read as indented code (`hello` + a pasted
  `    world` saves `hello    world`); several such lines are a code block. →
  plainTextPaste.ts `literalLine`,
  tests/editor-embed-milkdown-interactive-paragraph-lines.spec.ts
- In a list or task item, a pasted block lands inside the item, under the
  caret's line (`- item` + `# Title` saves `- item` with the heading nested
  under it), and a paste of nothing but a list adds its items to the list
  beside the caret's item (`- item` + `- x`/`- y` saves three items), splitting
  the item when the caret is mid-line. → plainTextPaste.ts `placeListItems`,
  plainTextPaste.test.ts
- A paragraph is one block however many lines it has: the native shells'
  long-press drag moves it whole.
- A newline at the very end of a note is not written (trailing whitespace is
  not content), so a note left ending in an empty line reloads without it. →
  packages/editor/src/milkdown-compat/trailingParagraph.ts `endsInUnwrittenBlank`,
  milkdown/hostHandleNote.ts `holdsExactly`
