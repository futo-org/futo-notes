## Editor verbs

**Two kinds of input.**

- **Real input**: top-level `type`, `press`, `tap` (and `click`, `drag` on desktop). The OS
  keyboard and touch, as a person produces them: keymaps, input rules, autocapitalization and
  the IME all run. Use them when the behaviour you are checking comes from input, then read
  `doc` back rather than assuming.
- **Editor verbs** (`do <Verb>`, the table below): direct edits through the editor, on the
  selection or at a position. None stands in for typing. Those `actions` marks
  `"convenience": true` (`Insert`, `Replace`, `ReplaceLine`, `ScrollToLine`, desktop's
  `AppendLine` and `InsertLine`) read text as markdown (`- [ ] tea` is a task, `**x**` bold) and
  land as one undoable edit, with no caret: use them to set a document up. `do Type` exists on
  desktop and Android (where it commits text, not keys), `do Press` on desktop only; iOS
  answers 501 for both.

**Positions.** UTF-16 offsets on iOS, ProseMirror positions on desktop (see below). Read them
from `doc`, `show {"text"}` or `state`; never count from markdown. `find` (exact text,
matched once) is preferred; offsets are the fallback. A verb aimed at text off screen is
refused 409 with the batch that brings it on: `ScrollToLine {"line"}` or Find. Wrong argument
names are refused with the call meant (`did you mean "at"? do PlaceCaret '{"at":16}'`):
`Replace {"find","text"}` (not `with`), `PlaceCaret {"at"}` (not `offset`), `Insert {"text"}`
with one of `at`, `after`, `before` (no `expect`).

| Verb | Arguments | Desktop | iOS | Android |
| ---- | --------- | ------- | --- | ------- |
| `Type` | `{"text"}` at the caret, a key per character; `\n` is Enter, `\t` Tab | ✓ keys through the editor's keymaps and input rules | — 501, use `type` | commits text through the input connection, not real typing |
| `Press` | `{"key"[,"count"]}`, chords as the keymap names them (`Mod-b`, `Shift-Enter`) | ✓ | — 501, use `press` | — 404 |
| `Insert` | `{"text"}` + one of `at`, `after`, `before`; `docVersion?` | ✓ | ✓ | `{"text"}` only, through the input connection |
| `Replace` | `{"text"}` + `find` or `from`+`to`; `expect?`, `docVersion?` | ✓ | ✓ | — 404 |
| `ReplaceLine` | `{"line","text"}` | ✓ | ✓ | — 404 |
| `AppendLine` · `InsertLine` | `{"text"}` · `{"afterLine","text"}` | ✓ | — 501, use `Insert` | — 404 |
| `Select` | `{"find"}` or `from`,`to`; `expect?`, `docVersion?` | ✓ drag, backward allowed | ✓ `from` ≤ `to`, no backward | `{from, to?}` |
| `PlaceCaret` | `{"at"}`; `docVersion?` | ✓ refused between blocks | ✓ | — 404 (`Select` with `from` only) |
| `SelectAll` | the edit menu's Select All | — | ✓ | — 404 |
| `Copy` · `Cut` · `Paste` | selection to puppet's private clipboard (`clipboard` fills it); 409 when empty | ✓ | ✓ note body and a focused table cell | — 404 |
| `ScrollToLine` | `{"line"}` | ✓ | ✓ | — 404 |
| `ToggleTask` | `{"line"}` (desktop, iOS) or `{"find"}` (iOS); `docVersion?` | ✓ | ✓ | — 404 |
| `OpenLink` | `{"at"}` or `{"find"}`; `newTab?` (desktop): follows the link | ✓ | ✓ `{"find"}` | a different verb of the same name: the toolbar's link dialog (iOS's `Link`) |
| `AcceptSuggestion` | `{"index"}` (0-based) or `{"text"}` (label or note id) | — (`PickLinkSuggestion {noteId}`) | ✓ only while wikilink suggestions show | — 404 |
| `PickLinkSuggestion` | `{"noteId"}` while `[[` suggestions show | ✓ | — 501 | — 404 |
| `MoveBlock` | `{"line"}` + `before` or `after` line | ✓ | — 501 | — 404 |
| `InsertImage` | `{"path"}` | ✓ | — 501, `tap` the toolbar's image button | — 404 |
| `Undo` · `Redo` | 409 with nothing to undo | ✓ | ✓ editor or cell focused | `Undo` only, while a table cell is open |
| `Bold` `Italic` `Strikethrough` `Heading1`-`Heading3` `Quote` `CodeBlock` `BulletList` `OrderedList` `TaskList` `Indent` `Outdent` | the toolbar's commands, on the selection or the caret's block | ✓ | ✓ editor or cell focused | — 404 |
| `Code` · `Paragraph` | toolbar commands | ✓ | — 501 (`Paragraph`: toggle the heading off with its own verb); no `Code` | — 404 |
| `Link` | opens the link field | ✓ then `SetLinkUrl {url}`, `ApplyLink` or `CancelLink` | ✓ opens iOS's system link prompt alert: fill with real `tap` and `type` (`SetLinkUrl`/`ApplyLink`/`CancelLink` are 501) | — (`OpenLink`, then `SetLinkLabel`, `SetLinkDestination`, `SubmitLink`, `RemoveLink`, `DismissLink`) |
| `LinkSelection` · `PickSlashItem {item}` | desktop's floating selection toolbar, the `/` menu | ✓ | — 501 | — 404 |
| `OpenTableRowMenu` · `OpenTableColumnMenu` `{line, item?}` | table grips; then `InsertRowAbove`… `DeleteColumn` | ✓ | — 501 | — 404 |
| `OpenFind` · `SetFindQuery {query}` · `StepFind {direction}` · `CloseFind` | `state.editor.find` has `open`, `query`, `current`, `total` | ✓ | ✓ | ✓ native find bar |
| `SetTitle` | `{"title"}`: types into the title field, settles once the rename has saved, so the receipt names the new id | ✓ | ✓ | ✓ |
| `FocusEditor` · `BlurEditor` | | — | — 501: `tap` the note body; the toolbar's Dismiss keyboard | ✓ |
| `AcceptWikilinkCompletion` · `DismissWikilinkCompletion` · `FinishTableCell` | Android's names for a suggestion pick, its Close, leaving a cell | — | — 501: `AcceptSuggestion`; `tap` Close; `tap` outside the table | ✓ |

`actions` lists what is available now (toolbar verbs only while the editor or a cell is
focused). A verb another platform has that the iOS app lacks answers **501**
`{"ok":false,"unsupported":true,"platform":"ios","verb":…,"error":"<Verb> is not supported on this platform (iOS): <what to use instead>"}`,
distinct from 404 for a name nobody knows. The same covers the menus iOS owns itself
(`ToggleNoteActionsMenu`, `Open*ContextMenu`, `CloseContextMenu`, `ToggleSortMenu`,
`SetSortOrder`): `tap` them. Android answers 404 for a missing verb; its `doc`, `at`,
`show {"text"}`, `events` and `diff` answer 404 ("unknown native editor query"). That is a gap
until Android adopts the iOS contract.

**Convenience verbs equal their tap.** On iOS `ToggleTask`, `OpenLink`, `AcceptSuggestion`
and the toolbar verbs land in the same state as their real tap: source, selection, undo
history and (after navigation) screen. `tests/ios-editor-stories.mjs` checks that.

### iOS: the native editor

There is no editor page: the note is a native UIKit editor, so there are no `e`-refs and
nothing to shift. Everything is in screen points; positions are UTF-16 offsets into the display
text from the editor projection. Hidden Markdown markers do not count, table-cell positions
map into the same text, and an offset inside a multi-unit character (emoji, combining) is
refused 400. `find`, `Select`, `PlaceCaret` and the ranges of `Insert`/`Replace` must be on
screen (409 otherwise).

**`press` takes only the keys the editor handles:** Enter, Backspace, Delete, Tab, the four
arrows, plus the explicit `Shift` modifier press. Escape, Home, End, PageUp and PageDown are
refused; there are no modifier chords (the app defines no keyboard shortcuts). Typing is the
OS keyboard's: it autocapitalizes a sentence's first letter, as for a person.

**`doc`** returns `docVersion`; `text` (the whole display text, no cap); `source` (the whole
Markdown source from the engine); `visible` (`{from, to}`, the part a real
tap can reach, `null` when covered); `onScreen`; `more`; and `lines` for every line (`line`,
`at`, `end`, `kind`, `text`). A line off screen carries `"offscreen": true` and no
`runs`/`md`. `doc {"line":N}` answers any line. `show {"text"}` and `at {x,y}` stay limited to
what is on screen.

**Reads never change anything.** `state`, `doc`, `show`, `at`, `elements`, `actions` and
`look` do not commit composition, move the selection, request a save or checkpoint, or touch
undo history. `file` still saves the open note first unless `"save":false`.

**`state.editor.selection`:** `from`, `to`, `empty`, `text` (first 80), `line`, `col`,
`formats`, and for a non-empty selection `direction`: `"forward"` when puppet's own `Select`
made it, `"unknown"` otherwise. There is no `anchor`/`head`.

**`docVersion`** moves with the engine revision and when another note opens, and carries a
process nonce. Pass it (from `doc` or `state.editor`) and a stale one is refused 409 before
anything changes. `Select` also takes `"expect":"<text at from-to>"`. In a batch, once a step
has edited the text, a later bare `at`, `from` or `to` is refused before it is sent unless it
carries `expect`, `find`, `after`, `before` or `docVersion`. Line numbers are not guarded:
read `doc` between steps, or edit from the bottom up.

**Real-tap targets.** `elements` lists the keyboard toolbar's buttons (section `keyboard
toolbar`, which scrolls sideways); in section `editor`, each on-screen task checkbox (role
`checkbox`, text the task's, flag `checked`) and each link or wikilink (role `link`, `broken`
when it opens nothing); and wikilink suggestions as buttons while the list shows, with its
Close button. `at {x,y}` adds `control: {kind:"checkbox", line, checked}` or `{kind:"link",
opens:"note:<id>"|"<url>"}` for what is under the point; a point a toolbar button or a
suggestion takes answers `element: {role, text, x, y, w, h, section}` instead of an editor
position. `show {"ref":"n…"}` gives any of them by ref.

**Receipt of a successful editor verb:** `docVersion: {before, after}`; `selection`
(`{from,to,empty,direction?}`); `changed` (whether the note's source changed); `editor`
(state after); `diff` (doc hunk and selection); and, per verb, `wrote` (`Insert`, `Replace`,
`ReplaceLine`), `task` (`ToggleTask`), `opened` (`OpenLink`), `accepted` (`AcceptSuggestion`),
`selected` (`Select`, `PlaceCaret`). No `events`. Once a verb has changed the note it never
answers with a retryable refusal: a later failure is 500 with `changed:true,
retryable:false` and the new `docVersion`; a toolbar command still running on a huge
selection after 5 s is 500 with `pending:true, retryable:false`, and lands on its own
(receipts.md).

**Recipe.** `just test-ios-editor-stories` (needs a claimed `$SIM`) builds, launches and runs
`tests/ios-editor-stories.mjs`: a puppet-only story of the editing loop, compared against the
saved source on disk. Read it for worked sequences.

### Desktop: the editor is a rendered document

The desktop editor is Milkdown (ProseMirror): a heading
is a heading block, bold a mark on a run of text, a task's box a flag on its list item, a
wikilink a chip. Positions are ProseMirror's own: each character is one and each block
boundary one more, so a line's caret positions run from its `at` to its `end` and the gap
between two lines is never one. `doc` prints every line with its `at-end`, its kind and the
text the screen shows, and under it as `md│` the markdown that will be saved, wherever that
differs. A link to a note reads as the words its chip shows, `[[atlas/roadmap]]`, and
`[[roadmap]]!broken` when it opens no note; an image reads as `[image photo.png]`.
`doc` lists the lines on screen only, and `doc {"line":N}` describes one visible line: each
run with its position and formatting (`bold`, `italic`, `code`, `link <url>`), each inline
object (a link's one position and the note it `opens`, or `broken`; an image; a soft line
break) and the `#tags` the editor paints, which are text, not formatting.

Typed input on desktop: `PlaceCaret` or `Select`, then `Type` / `Press`; each key goes to the
editor's keymaps and each character through its input rules (`# ` makes a heading, `[[` opens
link suggestions, Enter continues a list). A key no handler claims is the page's to carry
out: an arrow, Home or End moves by `doc` line, not by the line as drawn, and Backspace or
Delete removes one code point. When that default is the question, send the keyboard's own keys
with `type` and `press` (gestures-and-keys.md).

`find` matches the text `doc` shows on screen, lines joined by newlines, literally and once:
nothing matched is a 409 naming the string; several is a 409 listing every position.
`AppendLine` adds a block at the end (filling the empty last line the editor keeps after a
list or heading; `""` leaves a blank line); `InsertLine` adds one after that line's block;
`ReplaceLine` over a whole paragraph with `## …` makes it a heading, as pasting does. `Insert`
and `Replace` receipts carry `wrote: {from, to, removed, inserted}`. `Select` drags from
`from` to `to`, across lines if they are; exactly one node's positions (a divider, an image)
select it. `PlaceCaret` between blocks is refused: use a line's `at` or `end`. `Paste` reads
markdown as markdown and a list pasted into a list joins it; `clipboard {"text","html"?}`
fills it as copying from another app would. `Press` modifiers: `Shift-Enter` (a line break
inside a table cell), `Shift-Tab`, `Mod-b` (`Mod` is Cmd on Apple, Ctrl elsewhere), `Mod-z`,
`Backspace`, `Home`, `ArrowUp`, `Shift-ArrowLeft`, any character. `MoveBlock` drags the line's
block by its handle and drops it beside another's; a list moves whole; 409 when the drop
changes nothing. Desktop positions go stale the moment anything edits the text; a receipt's
`diff.doc` is the minimal hunk between the saved markdown either side, so it can start
mid-word, and `doc` answers "what does it say now".
