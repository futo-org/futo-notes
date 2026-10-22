## Markdown house style — what a save writes

A save writes ONE fixed spelling, stated here line by line. A dispute about a
byte is settled by these lines, not by the code. → packages/editor/src/markdown/
(the serializer), tests/conformance/markdown-house-style-*.json (the
hand-reviewed goldens, one or more per line below)

- Opening a note never rewrites it; the first real edit re-spells the whole
  note into this style, once (see "WYSIWYG rendering").
- The style never remembers how the file spelled something: not its list
  markers, its `_` or `*`, its `1)` numbering, its padding, or its line endings.
- Every device writes identical bytes for the same document.
- A second save is a no-op: writing a document, reading the result back, and
  writing again gives the same bytes.
- Line endings are LF, except inside a front matter block, which is written
  back byte for byte (story 16 wins over this line there).
- A non-empty file ends in exactly one newline; an empty note is an empty file.
- A save costs time in proportion to the blocks that changed, not to the
  length of the note.

### Text and escaping

- A character is escaped only when the app's own parser would otherwise read
  the line as a different document, and that is decided by parsing what would
  be written, not by a list of risky characters. So `snake_case`, `$x_1$`,
  `#tag` at the start of a line, `1.5` and `a * b` are written as typed,
  while `\# not a heading`, `1\. not a list`, `\*not italic*` and `\<div>`
  get the one backslash that keeps them text.
- When either of two delimiters could carry the escape, the opening one does.
- A character that cannot take a backslash is written as a character
  reference where the parser would otherwise reinterpret it: the letter or
  space beside formatting that would not otherwise open or close
  (`**Note:**&#x62;ar`, `x **&#x20;a**`).
- The formatting marker changes in one case only: an italic or bold run that
  starts exactly where another `*` run ends is written with `_` if, and only
  if, a parse says the two `*` runs would merge.
- Whitespace at the end of a line is not written: the parser drops it on every
  read, so writing it would only make the next save differ.
- Whitespace at the start of a line of a paragraph, heading or table cell is
  not written either, also where formatting opens the line (`**  a**` is
  written `**a**`), and never as a character reference (`&#x20;`, `&#x9;`).
  The parser drops it on every read, so it is not content (the census
  content-loss gate does not count it): written as typed, it would read back
  without it and the next save would differ. Inside a
  link's text or a code span it is kept, and so is whitespace after a task
  item's `[ ] `, which is not a line's start in the file: the parser keeps it
  there (`[ a](u)`, `- [ ]  x`). Code, HTML and front matter lines keep
  theirs too.
- A line break at the very end of a paragraph or heading is not written, for
  the same reason.

### Paragraphs and line breaks

- An inline line break (one Enter, or a single newline the file already had)
  is written as one `\n`.
- A newline directly before inline HTML stays a newline.
- An empty line inside a paragraph (two line breaks in a row, as Enter at the
  end of a line with a line below it makes; a line holding only whitespace is
  empty; one holding only a link's opening `[` or closing `](…)` is not) is
  written as an empty line, never as a character reference, a backslash or a
  space. In the file an empty line is a paragraph break, so `one`, two line
  breaks, `two` is written `one\n\ntwo` and reads back as two paragraphs.
- Each further empty line in the same run is one empty paragraph between the
  two paragraphs (`one\n\n\ntwo` for three line breaks).
- Empty lines at the start of a paragraph are empty paragraphs before it.
- The line break before an empty line ends a paragraph, so it is not written,
  even an older file's hard break (`\`).
- An older file's hard break (`\` or two trailing spaces) is written as `\`
  plus a newline in a paragraph.
- A hard break in a table cell is written `<br>`.
- A heading is one line: its line breaks, a setext heading's included, are
  written as spaces.
- An empty paragraph is an extra blank line, never HTML: `N` empty paragraphs
  between two blocks are `N + 1` blank lines.
- `N` empty paragraphs before the first block are `N` blank lines at the top of
  the file.
- Empty paragraphs at the end of the note, or at the start or end of a quote,
  list item or footnote, are not written.

### Blocks

- Headings are ATX: one to six `#`, a space, the text. Never setext.
- A thematic break is `---`.
- A thematic break on the note's first line is `---` too, unless a parse
  shows `---` there would open front matter: a later line of the note would
  close it (a later `---` rule, or a `---` line in a code block). Only then is
  it `***`.
- Inside a quote, list item or footnote, a thematic break is `***` wherever a
  parse reads `---` as something else: right under a paragraph (a setext
  underline), or as the first thing in a `-` item (a list item, not a rule).
- Bold is `**text**`, italic `*text*`, bold italic `***text***`, strikethrough
  `~~text~~`.
- Marks over the same text nest strikethrough outermost, then bold, then
  italic (`~~***text***~~`).
- Two italic (or two bold) runs that touch are written as one.
- Inline code is a backtick run one longer than any run inside it (`` `a` ``,
  ``` `` a`b `` ```).
- Inline code gets one space of padding on each side when it starts or ends
  with a backtick, or starts and ends with a space.
- Fenced code uses backticks — at least three, and one more than the longest
  run of backticks that starts a line inside — then the language, the content
  exactly as held, and the closing fence.
- A fenced code block whose language contains a backtick gets a `~~~` fence
  instead.
- A blockquote prefixes each line with `> `, and a blank line inside it with
  `>`.
- Inside a quote, a list that touches another list or a quote is written
  directly above it, with no blank `>` line: the parser reads a list followed
  by a blank `>` line and then a list or a quote as loose.
- Where the parser's reading of a list inside a quote or a tight item needs a
  blank line the rules above would not write (a paragraph after a nested list
  in a tight item, the end of a quote after a loose nested list), or an HTML
  block that followed a tight item's paragraph on an unindented line, that
  layout is written — decided by parsing, and only where it keeps the list as
  tight or loose as it was.
- A front matter block is written byte for byte: `---`, its body exactly as
  read, CR and CRLF line endings included, and `---`, followed by a blank line
  before the note's body (which is LF).
- The two fence lines end the way the front matter body's first line does,
  and with LF when the body is a single line: the parser keeps no line ending
  that touches a fence, so a one-line body from a CRLF file is written with
  LF fences.

### Lists

- Bullets are `-`.
- Ordered items are numbered as they appear on screen: the list's start
  number, then one more per item, each followed by `.`.
- A tight list stays tight (one newline between items) and a loose list stays
  loose (a blank line between items).
- Inside an item, its blocks are separated the same way the item itself was
  read: a newline when tight, a blank line when loose.
- Two paragraphs in a row in a tight item (what Backspace at the start of a
  nested item leaves) are written tight, as two lines of one paragraph:
  `- a\n  b`. They read back as one paragraph with a line break, which looks
  the same. A file never holds the shape, so only the editor's own document is
  ever re-spelled this way; a paragraph that is one HTML block is not joined
  (the block would take the next line into itself).
- An item whose blocks only a blank line keeps apart is written loose, because
  no tight spelling exists for it: an empty paragraph between two blocks, an
  empty line inside one of its paragraphs (a paragraph break in the file), or
  a paragraph after one that is an HTML block.
- An item's continuation lines are indented by the width of its own marker:
  two spaces under `- `, three under `1. `, four under `10. `. A nested list
  therefore parses back at the same depth.
- Two lists of the same kind that touch, or that only empty paragraphs
  separate, alternate markers — `-` then `*`, `1.` then `1)` — because
  CommonMark would otherwise read them as one list.
- A task item is `- [ ] text` or `- [x] text`.
- An empty task item is `- [ ]`, never a bare `-`.
- An empty item is its marker alone (`-`, `1.`).
- An item whose first block is not a paragraph writes that block on the marker
  line (`- > quote`, `- # heading`).

### Tables

- Every cell has one space either side of its content and the columns are not
  padded to a common width: `| a | b |`.
- An edit to one cell never re-spells another row.
- A table with no body row is written with none. The editor shows one empty
  row under its header (a table needs one) and writes it only once a cell in
  it holds something; a body row the author wrote, empty or not, is always
  written. → packages/editor/src/milkdown-compat/tableFillerRow.ts
- The delimiter row is `---` for a column with no alignment, `:--` left, `:-:`
  center, `--:` right. A column the author never aligned stays unaligned.
- A `|` inside a cell is written `\|`, in code, wikilinks, and link and image
  destinations and titles too.
- A line break inside a cell is `<br>`, at the end of the cell too: the
  parser reads `x<br>` back as `x` and a line break.
- A cell holding two or more line breaks and nothing else writes each one as
  `<br>`: `| <br><br> |` reads back as two line breaks.
- A cell holding a single line break and nothing else is written empty: a
  lone `<br>` in a cell reads back as an empty cell, so no spelling keeps it.

### Links, images and the constructs the editor does not model

- A link is `[text](url)` or `[text](url "title")`.
- A link or image destination with a space, a backslash, a control character
  or unbalanced parentheses in it, or one that starts with `<`, is written
  `<url>`; balanced parentheses stay bare (`wiki/Foo_(bar)`).
- A link whose text is its own URL (`https://…`, `www.…`, an email address) is
  written bare whenever the bare text reads back as the same link, and
  otherwise as `<url>` (as `[www.…](http://www.…)` for a `www.` link, which
  has no `<…>` form).
- An image is `![alt](src)`, with `"title"` only when it has one; a save never
  adds a title.
- A wikilink is `[[target]]` with the target exactly as held.
- A footnote reference is `[^label]`.
- A footnote definition is `[^label]: text`, with continuation lines indented
  four spaces.
- Inline HTML, HTML blocks, front matter bodies and unused link reference
  definitions are written back exactly as read, with two exceptions below
  that do not apply to front matter.
- An HTML block's indentation before its first tag is not written: it is
  layout, not HTML, and kept it would put the block in a different container
  once list indentation is the house style's.
- CR and CRLF line endings inside them (front matter aside) are written LF.
