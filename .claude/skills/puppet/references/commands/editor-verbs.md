## Editor verbs

**The editor is a rendered document, not its markdown.** It is Milkdown (ProseMirror): a
heading is a heading block, bold is a mark on a run of text, a task's box is a flag on its
list item, a wikilink is a chip. Positions are ProseMirror's own — each character is one,
and each block boundary one more — so a line's caret positions run from its `at` to its
`end`, and the gap between two lines is never one. `doc` prints every line with its
`at-end`, its kind and the text the screen shows, and under it as `md│` the markdown that
will be saved, wherever that differs. A link to a note reads as the words its chip shows,
`[[atlas/roadmap]]`, and `[[roadmap]]!broken` when it opens no note (none or several match);
an image reads as `[image photo.png]`. Read positions from `doc`, `show {"text"}` or `state`; never
count them from markdown. A verb aimed at a line or text off screen (for a range, its start: a
drag autoscrolls to its end) is refused with the batch that brings it on: `ScrollToLine
{"line"}`, a convenience (a scroll wheel's work in one call) that refuses 409 when the line
still does not come on screen.

**Text arrives two ways, and which one matters.**

- **Fast writes** — `AppendLine`, `InsertLine`, `ReplaceLine`, `Insert`, `Replace`
  (`actions` marks them `"convenience": true`). One call, no caret: the text is read as
  markdown, the way the editor reads a note, and lands as one undoable edit — `- [ ] tea`
  is a task, `**x**` bold, `## H` a heading. **They are not input a person can produce**:
  no keymap, no input rule, no handler runs. Use them to set a document up, or for any
  edit that is not what you are checking.
- **Typed input** — `PlaceCaret` or `Select`, then `Type` / `Press`. Each key goes to the
  editor's own keymaps and each character through its input rules, so `# ` at a line start
  makes a heading, `- ` a bullet, `[[` opens the link suggestions, Enter continues a list.
  **When the behaviour you are checking comes from typed input**, use these, and read the
  document back after typing rather than assuming. A key no handler claims is the page's to
  carry out, not the browser's: an arrow, Home or End moves by `doc` line, not by the line
  as drawn, and Backspace or Delete removes one code point. When that default is the question
  (an arrow on a wrapped line, `End` on a Mac), send the keyboard's own keys with `type` and
  `press` (gestures-and-keys.md).

The argument names agents guess wrong most: `Replace {"find":"…","text":"…"}` (not `with`),
`PlaceCaret {"at":N}` (not `offset`), `InsertLine {"afterLine":N,"text":"…"}`, `Insert
{"text":"…"}` with one of `at`, `after` or `before` (no `expect`: that is `Select`'s and
`Replace`'s). A misnamed one is refused with the call it meant: `did you mean "at"? do
PlaceCaret '{"at":16}'`.

| Verb                                                                        | Arguments                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Type`                                                                      | `{"text":"…"}` — typing at the caret, a key per character. A `\n` is the **Enter key** (in a paragraph a new line of it, in a list a new item), a `\t` the Tab key. Typing over a selection replaces it                                                                    |
| `Press`                                                                     | `{"key":"Enter"}` (`"count":N` times) — one key, with modifiers as the editor's keymap names them: `Shift-Enter` (Enter's twin, but a line break inside a table cell), `Shift-Tab`, `Mod-b` (`Mod` is Cmd on Apple, Ctrl elsewhere), `Mod-z`, `Backspace`, `Home`, `ArrowUp`, `Shift-ArrowLeft`, any character |
| `AppendLine` · `InsertLine` · `ReplaceLine`                                 | **fast write, not real input.** `{"text"}` · `{"afterLine","text"}` (0 = before line 1) · `{"line","text"}`. `AppendLine` adds a block at the end (filling the empty last line the editor keeps after a list or heading; `""` leaves a blank line); `InsertLine` adds one after that line's block — after a list item, a sibling item; `ReplaceLine` rewrites the line's text, and `## …` over a whole paragraph makes it a heading, as pasting does |
| `Insert` · `Replace`                                                        | **fast write, not real input.** `Insert {"text"}` with one of `at`, `after`, `before`; `Replace {"text"}` with `find` or `from`+`to` (`expect?`, `docVersion?`). Inline text joins the line it lands in; empty `text` deletes. Receipts carry `wrote: {from, to, removed, inserted}` (`removed` as far as it shows) |
| `Select`                                                                    | `{"find":"<exact text>"}`, or `from`, `to` · `expect?`, `docVersion?` — a drag from `from` to `to`, across lines if they are (the receipt's `selected.text` is the part on screen); exactly one node's positions (a divider, an image) select it. Focuses the editor, as a click does. Selecting and typing is how you replace text                                                      |
| `PlaceCaret`                                                                | `{"at":<position>}` · `docVersion?` — a click at that position: the caret, nothing selected. A position between blocks is refused: use a line's `at` or `end`                                                                                                                |
| `Copy` · `Cut`                                                              | the selection, through the editor's own copy handler (its text is markdown, as it would be on a clipboard); 409 with nothing selected. The agent's own clipboard (`clipboard`), never the OS one                                                                         |
| `Paste`                                                                     | the clipboard at the caret or over the selection, through the editor's paste pipeline (markdown is read as markdown, a list pasted into a list joins it). `clipboard {"text":"…","html"?:"…"}` fills it as copying from another app would                                     |
| `ToggleTask`                                                                | `{"line":N}` — the checkbox on that line, a task's first line, as tapping it does                                                                                                                                                                                         |
| `MoveBlock`                                                                 | `{"line":N}` with `"before":M` or `"after":M` — dragging the line's block by its ⠿ handle (a long press on a phone) and dropping it beside line M's, anywhere in the note. A list moves whole: the handle lifts a line's top-level block; 409 when the drop changes nothing or cannot land there |
| `OpenLink`                                                                  | `{"at":<position>}` or `{"find":"<its text>"}` · `newTab?` — a click on a link or a wikilink chip: opens the note (a new tab with `newTab`, as a middle click does) or the URL                                                                                              |
| `InsertImage`                                                               | `{"path":"/abs/file.png"}` — desktop: the image picker the `/` menu's Image opens, answered with that file                                                                                                                                                                |
| `Undo` · `Redo`                                                             | 409 when there is nothing to undo                                                                                                                                                                                                                                         |
| `Bold` `Italic` `Strikethrough` `Code` `Link` `Heading1` `Heading2` `Heading3` `Paragraph` `Quote` `CodeBlock` `BulletList` `OrderedList` `TaskList` `Indent` `Outdent` | the toolbar's commands, on the selection or the caret's block. `Link` opens the Link field: `SetLinkUrl {url}`, then `ApplyLink` (or `CancelLink`) |
| `LinkSelection`                                                             | desktop, while the floating selection toolbar is up: its Link button, which opens the same field                                                                                                                                                                          |
| `PickSlashItem {item}`                                                      | desktop, while the `/` menu is open (type `/` at a line start): a click on one of its rows. Arrows, Enter and Escape are `Press`                                                                                                                                           |
| `PickLinkSuggestion {noteId}`                                               | while the `[[` suggestions are up: a click on one                                                                                                                                                                                                                          |
| `OpenTableRowMenu {line, item?}` · `OpenTableColumnMenu {line, item?}` | desktop: a table cell's row or column grip; while its menu is open, `InsertRowAbove`, `InsertRowBelow`, `DeleteRow` (or `InsertColumnLeft`, `InsertColumnRight`, `DeleteColumn`)                                                                                                                                                      |
| `OpenFind` · `SetFindQuery {query}` (`""` clears) · `StepFind {direction: 1｜-1}` · `CloseFind` | `state.editor.find` has `open`, `query`, `current`, `total`                                                                                                                                                                         |
| `SetTitle {title}`                                                          | every platform; types into the title field, with its validation, and settles once the rename has saved, so the receipt names the new id                                                                                                                                  |

`doc {"line":N}` is one line in full: each run of text with its position and formatting
(`bold`, `italic`, `code`, `link <url>`), each inline object — a link to a note (one
position, and the note it `opens`, or `broken`), an image (one position), a soft line break —
and the `#tags` the editor paints, which are text, not formatting.

`find` matches the text `doc` shows on screen, lines joined by newlines — literally, and **once**.
Nothing matched is a 409 naming the string; several matches is a 409 listing every
position, so you extend the anchor rather than guess.

**Positions go stale the moment anything edits the text**, and they mean nothing in
another note. Pass `"docVersion"` (from `doc` or `state.editor`) and the verb
refuses when the document has moved on; `Select` also takes
`"expect":"<the text at from-to>"`. In a batch, once a step has edited the text, a later
step naming a bare `at`, `from` or `to` is refused before it is sent unless it carries a proof
(`expect`, `find`, `after`, `before` or `docVersion`). Line numbers are not guarded: read `doc`
between steps, or edit from the bottom up.

Typing does not report what it wrote — the document does. The receipt's `diff.doc` is the
minimal hunk between the saved markdown either side, on the line it starts (`doc L4
-"Sam" +"**Sam**"`), so it can start mid-word; `doc` is the answer to "what does it say now".
