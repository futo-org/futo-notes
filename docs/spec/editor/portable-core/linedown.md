# Linedown

The Markdown dialect the text-first editor reads and writes (#423). No engine change merges unless
it agrees with this file. The maintainers edit the dialect in an internal document; this file is
its copy of record for the repo and changes in the same merge request as the behavior.
→ crates/futo-notes-editor

A minimal markdown implementation focused on providing a good editing experience for note-takers.

**A line's meaning never changes because of a line after it. Earlier lines may set context for later ones.**

Linedown uses the characters of CommonMark and GFM, but reads them one line at a time. It describes how text is read. Editor conveniences, such as continuing a bullet on Enter or closing a code fence for you, are outside this document.

Status: draft, version 1. It applies to the text-first editor only.

## The principle

**A line's meaning never changes because of a line after it.** What you type can never restyle what is above your cursor.

In CommonMark this note has a heading in it:

```
grocery list
-
```

The `-` on the second line turns "grocery list" into a heading. In Linedown "grocery list" is a plain line, and it stays one whatever you type below it. Once you add a space, the second line is an empty bullet.

**Every line break is a line break.** There are no paragraphs. This note is two lines, and it shows as two lines:

```
foo
bar
```

A blank line is an empty line. Three blank lines show as three empty lines.

## When one line affects another

A line is read by its own text, with these exceptions. No others exist.

An earlier line affects later lines in four cases:

1. **Code fence.** After an opening fence, every line is code until the closing fence. With no closing fence, code runs to the end of the note.
2. **Front matter.** If line 1 is `---`, every line is front matter until the next `---`. With no closing `---`, it runs to the end of the note.
3. **List depth.** How deep a list item sits depends on the list lines above it.
4. **Table rows.** A line starting with `|` is a table row only when it follows a table's header and delimiter row.

A later line affects an earlier line in one case:

5. **Table header.** A delimiter row turns the single line directly above it into a table header. This is the only case where a line changes the meaning of a line before it.

## Blocks

Every line is exactly one of these.

| Block | Looks like | Rule |
|-------|------------|------|
| Plain line | `some text` | Anything that is not one of the blocks below. |
| Blank line |            | Empty, or only whitespace. |
| Heading | `# Title`  | One to six `#`, then a space. Starts at column 0. |
| Bullet | `- item`   | `-`, `*` or `+`, then a space. May be indented. |
| Numbered item | `1. item`  | Digits, then `.` or `)`, then a space. May be indented. |
| Task  | `- [ ] item` | A bullet followed by `[ ]`, `[x]` or `[X]`, then a space. |
| Quote | `> text`   | `>`, then a space. A `>` alone on a line is an empty quote line. |
| Divider | `---`      | Three or more of the same character, `-`, `*` or `_`, and nothing else on the line. Starts at column 0. |
| Code fence | three backticks | See "Code". |
| Front matter | `---` on line 1 | See "Front matter". |
| Table | rows starting with a pipe | See "Tables". |

### A marker needs a space

A marker counts only once it is followed by a space or a tab. Until then the line is plain text.

```
-          plain line
- milk     bullet
#          plain line
#tag       plain line holding a tag
# Title    heading
>quote     plain line
```

The one exception is `>` alone on a line, which is an empty quote line. Quoted text often uses it as the gap between two quoted passages.

### Headings and dividers start at column 0

An indented `# Title` or `---` is a plain line.

Closing hashes are not special: `# Title #` is a heading with the text `Title #`.

A divider has no spaces in it: `- - -` is a bullet with the text `- -`.

### Lists

**A list item is one line.** A plain line under a bullet is its own line and does not belong to the bullet, indented or not.

```
- buy milk
  the oat kind
```

These are two lines: a bullet and an indented plain line. The plain line is drawn lined up with the bullet's text, so it reads as part of the item, but each line stands alone.

**Depth comes from the list lines above.** A list line is one level deeper than the nearest list line above it with less indent, and the same depth as one with equal indent. Indent is compared by width, and a tab counts as 4 spaces.

```
- fruit
  - apples
  - pears
- bread
```

Two spaces, four spaces and tabs all nest correctly, and depth never jumps by two levels. A list line with no shallower list line above it is at the top level, even if it is indented.

**What ends a list.** The list lines above stop counting at the first line that starts at column 0 and is not a list item: a plain line, heading, divider or code fence. Blank lines and indented plain lines do not end the list.

**Indented plain lines in a list** are drawn lined up with the text of the nearest list line above that has the same indent or less. Outside a list, leading whitespace shows as typed.

**Numbers show as typed.** `3. item` shows a 3, whatever is above it. Nothing is renumbered when the note is read.

### Quotes

Every quoted line needs its own `>`. A plain line under a quoted line is not part of the quote.

```
> quoted
not quoted
```

Quotes nest with `>>` or `> >`.

### Stacking markers on one line

A line may start with any number of `>`, then at most one heading or list marker, then text.

```
> - item       a quoted bullet
> # Title      a quoted heading
- # Title      a bullet with the text "# Title"
```

### Code

A code fence opens with three or more backticks or tildes. It closes with a line of the same character, at least as many of them. Text after the opening fence is the language name.

````
```js
let x = 1
```
````

- Inside a fence nothing is read as markdown.
- The code keeps its own whitespace.
- The opening fence may be indented, for example under a bullet.
- A fence is not recognised after `>`.
- A fence with no closing line runs to the end of the note.
- List depth carries on after the closing fence.

Indented text is never code. Code is fences only.

### Front matter

If the first line of the note is exactly `---`, the lines up to the next `---` are front matter. With no closing `---`, front matter runs to the end of the note. A `---` anywhere else is a divider.

### Tables

A table is:

1. a header line starting with `|`,
2. a delimiter row directly under it, such as `|---|---|`,
3. every following line that starts with `|`, up to the first line that does not.

```
| item | qty |
|------|----:|
| milk | 2   |
| eggs | 12  |
```

- Every row starts with `|`.
- Colons in the delimiter row set alignment: `:---` left, `:---:` centre, `---:` right.
- Cells hold inline text only. `\|` is a literal pipe.
- A row with too few cells is padded. A row with too many is trimmed.
- Tables are read only at the top level, not inside quotes or lists.
- Until the delimiter row exists, `| item | qty |` is a plain line.

## Inline

Inline marks open and close on the same line. A line break ends them.

| Mark | Looks like |
|------|------------|
| Bold | `**text**` or `__text__` |
| Italic | `*text*` or `_text_` |
| Strikethrough | `~~text~~` |
| Inline code | `` `text` `` |
| Link | `[text](url)` |
| Bare URL | `https://example.com` or `<https://example.com>` |
| Image | `![alt](src)` |
| Wikilink | `[[note]]` |
| Tag  | `#tag`     |
| Escape | `\*` shows a literal `*` |

The rules for when `*`, `_` and `~` open and close are CommonMark's, applied to one line. So `snake_case_word` is not italic.

Bold left open on one line is literal text. It does not carry to the next line:

```
**this is not bold
and neither is this**
```

## Differences from CommonMark and GFM

| Text | CommonMark | Linedown |
|------|------------|----------|
| `title` with `---`, `===` or `-` under it | Heading    | Plain line, then a divider, plain line or bullet |
| `foo` then `bar` on the next line | One paragraph; many renderers join the lines | Two lines |
| Several blank lines in a row | Collapsed to one gap | Shown as written |
| Plain line under a bullet | Part of the bullet | Its own line |
| Plain line under a `>` line | Part of the quote | Its own line, not quoted |
| Text indented 4 spaces | Code block | Plain line, or list nesting |
| `**bold` across two lines | Bold       | Literal asterisks |
| `1.` `1.` `1.` | Shows 1, 2, 3 | Shows 1, 1, 1 |
| `-` or `#` with nothing after | Empty bullet, empty heading | Plain line |
| `>text` with no space | Quote      | Plain line |
| Table row with no leading pipe | Table row  | Plain line |
| `- - -` | Divider    | Bullet   |

## Not in version 1

These have no meaning in Linedown and show as the literal text you typed:

- Setext headings (a line of `===` or `---` under text)
- Reference links (`[text][ref]` with a definition elsewhere in the note)
- Footnotes
- Raw HTML
- HTML entities such as `&amp;`
- Indented code blocks
- Hard-break spellings: a trailing backslash shows as `\`, and trailing spaces are spaces

## Files

Notes stay `.md` files. Linedown never rewrites a file to fit these rules, and adds nothing to a file to make other apps agree with it. Other markdown apps may show the same note differently, most often by joining lines.

## Addendum

### Why not CommonMark

In CommonMark a line can change what its neighbours mean. An editor built on it has two choices when that would misread what you typed: show you the wrong thing, or quietly write extra characters into your note to prevent it. Ours did the second. These are things our CommonMark editors wrote into notes that nobody typed:

You type a line that starts with two spaces:

```
one
  two
```

The file gets an HTML entity, because CommonMark drops leading spaces and reads four of them as code:

```
one
&#x20; two
```

You type a lone `#` on a line. The file gets `&#35;`, so that it cannot become an empty heading.

You insert a divider under a line of text. The file gets `***`, not the `---` you asked for, because `---` would turn the line above into a heading.

You make two lists with a gap between them. The second list's bullets are switched from `-` to `*`, because CommonMark would otherwise merge the two lists into one.

You add an empty bullet under a line of text. A blank line is inserted above it, because the lone `-` would turn the line above into a heading.

Each of these is a patch over one rule: a line's meaning can depend on the lines around it. Every patch leaves text in the file that the author did not write and that other apps display. Linedown removes the rule, so the patches have nothing to fix. A note holds what you typed.

### Why list depth looks at the lines above

Depth is the one place where a list line is not read by its own text. Two simpler rules were considered, and both misread ordinary notes.

**A fixed width per level**, such as "every two spaces is one level", needs no context. But people indent by two spaces, four spaces or a tab, often in the same vault. This note indents by four:

```
- fruit
    - apples
```

Under a fixed two-space rule, "apples" lands two levels deep with nothing at the level between. Under a fixed four-space rule, every two-space note stops nesting at all.

**CommonMark's rule** is that a nested item must be indented to the column where its parent's text starts. That column depends on the parent's marker:

```
1. fruit
  - apples
```

Here "apples" is indented two spaces, but the text of `1. fruit` starts at column three. So CommonMark does not nest it: "apples" becomes a separate list. Under `10. fruit` it would take four spaces. The author has to count columns, and the answer changes when a number gains a digit.

**Linedown's rule** asks one question: is this line indented more than the list line above it? If so it is one level deeper. Both notes above nest the way they look, and so does a tab. The cost is that depth depends on earlier lines, which is why it is listed under "When one line affects another". It never depends on later ones.
