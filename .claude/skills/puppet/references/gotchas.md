# The app you are driving, and where it lies to you

Read `.claude/skills/puppet/SKILL.md` first; this is the detail behind it.

## The app you are driving

**Screens.** `actions` prints the screen on its first line; `state.screen`
agrees.

| Target  | Values                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------ |
| desktop | `home` · `editor:<noteId>` (`editor:new` for an unsaved new note)                                      |
| iOS     | `list` · `folder:<path>` · `editor:<noteId>`                                                           |
| Android | `list` · `folder:<path>` · `editor:<noteId>`, plus `search`, `settings`, `storage`, `sync`, `feedback` |

**Overlays do not change `screen`.** Settings, search, context menus, dialogs
and the find bar _add_ their verbs while open and remove them when closed;
`state` reports `settingsOpen`, `searchOpen`, `editor.find.open`. So the way to
know a surface is open is `state` or `actions`, not `screen`. Settings, search and
dialogs also take away every verb behind them, the editor's included, until they
close; only the window's shortcuts stay.

**Notes.** A duplicate title yields `<title>-2`. Ids and how to list them:
`commands.md`.

**Creating a note differs by target.** On a phone `CreateNote` is the list's New note
button: it creates an untitled note in the folder on screen and opens it (the title is
`SetTitle` after). On desktop `CreateNote` takes no arguments too and
creates an `Untitled` note (`Untitled-N` beside another) before opening it: `screen`
is `editor:<id>` at once, and `SetTitle` renames it. Left untouched (body empty,
never renamed), it is deleted when you leave it, as on a phone.

**The editor on desktop** is the engine's own (features/editor/desktop): a contenteditable
page over the Rust engine, its positions the engine's display text in UTF-16 units, one line
of it per line of the file, a list item's marker one unit at the line's start
(`commands/editor-verbs.md`). An image, a divider and a wikilink are one object each.
`state.editor` reports `note` (the path of the note it holds), `onScreen` (which lines show),
`docVersion` (the engine's revision, from 0 each time a note opens), `focused`, `ready`, `idle`,
`find`, `flag` (the formats the next letter takes) and `selection` with `from`/`to`,
`anchor`/`head`, `line`/`col` and the selected `text`. It has no Undo depth. iOS and Android
edit in native editors (iOS: UTF-16 offsets into the display text; editor-verbs.md).

**Formatting verbs read the selection.** On desktop they are the selection toolbar's
buttons (`Bold`, `Heading2`, `Quote`, …), there only while text is selected: `Select`
first, then the verb. A list, a code block or Indent is a key (`press`).

**iOS store verbs are native Swift** over the Rust store. From an open editor,
navigation refuses 503 until you `GoBack`, and renaming or deleting the _open_
note refuses 409 — that note belongs to its session.

## Traps

- **A position outlives the document it was read from by nothing at all.** The
  first edit shifts everything after it, so the second half of a plan built on
  one `doc` read lands in the wrong place — and formatting verbs do that
  silently, with a 200 and a plausible diff. Anchor by text (`Replace {"find"}`,
  `Select {"find"}`, `Insert {"after"}`) and the question never arises; a batch
  that reuses a bare position across an edit is refused before it is sent.
- **On desktop the first edit rewrites nothing else.** The file keeps its own bytes; the
  receipt's `doc` hunk is the change in them, so `doc L4 -"Sam" +"**Sam**"` is what landed.
- **A vanished sidebar row is not a deletion.** The tree draws nothing inside a
  collapsed folder, so a note can be in the vault with no row.
  `notes` is the vault itself — use it to confirm a move, rename or delete
  instead of reading the tree. (Deleting a folder's last note does delete the
  folder, so that row really is gone.)
- **A new note is named `Untitled` until you `SetTitle`.** Desktop `CreateNote`
  creates the file before it opens, so `state.note` is the new id at once; typing
  never renames it.
- **What you type is not always what lands.** Real typing (`type`; desktop's `do Type`)
  delivers a `\n` as the Enter KEY and every character through the editor's input rules, so
  `# ` makes a heading, `- ` a bullet, `---` a divider, and Enter inside a list continues it —
  which is what it does to a person. To just put text in a document, the direct edits
  (`Insert`, `Replace`, `ReplaceLine`; desktop's `AppendLine`, `InsertLine`) read it as
  markdown in one step.
- **iOS `type` leaves Shift held after a capital letter** for the later keys (papercut
  pc_7e2c60a86250), and the keyboard autocapitalizes a sentence's first letter. Read `doc`
  back after typing.
- **JSON holding an apostrophe goes in double quotes**, its own quotes escaped:
  `do OpenNote "{\"noteId\":\"mom's list\"}"`. The `'\''` and `'"'"'` tricks are refused as
  brace expansion; a refusal's suggested command is already written this way.

## Gaps to know about

- **A phone's editor queries refuse off the editor screen**: `doc`, `at` and `show {"text"}`
  are 409 from `list` or a folder, where `elements` reads the native rows. `state`, `notes`,
  `search`, `file` and `clipboard` answer everywhere. `events` and `diff` are desktop's.
- **Android's editor is behind iOS's contract**: no `doc`/`at`/`show {"text"}` (404), `Type`
  and `Insert` commit through the input connection, missing verbs are 404 not 501.
- Desktop real input (`click`, `drag`, `scroll`, `hover`, `type`, `press`) is handed by the app to its
  own web view, on macOS, Linux and Windows alike. `tap` on desktop refuses and
  names `click`; `click` on a phone refuses and names `tap`. The window need not be focused
  and is never activated, so `state.editor.focused` and `document.hasFocus()` stay false
  while the human is elsewhere; DOM focus still moves, which is what focus bugs are about.
- A desktop `drag` also takes `"path":[[x,y],…]` (out and back), `"count":2` and
  `"shift":true`; once pressed it may go past the window (a drag that scrolls).
- A desktop `drag` that starts on selected text stays a selection drag: the trace bracket
  cancels `dragstart`, because an OS drag-and-drop begun by synthesized events can only be
  ended by a real mouse-up and wedges the window until then. Text drag-and-drop is therefore
  the one mouse behaviour `drag` cannot exercise.
- A desktop right-click where the app shows no menu of its own (in the note, a text field, a
  selection) would open the web view's native text menu (Cut, Copy, Paste, spelling), which no
  read sees and which takes every later click until a person closes it. The trace bracket holds
  it back, so `click {"button":"right"}` there shows the page's `contextmenu` and nothing more;
  the native menu is the other thing real input cannot exercise. Copy, Cut and Paste are verbs.
- `do` from raw `curl` skips the pending poll, the target vetting and the trace
  file. Use the CLI.

Design record: `docs/research/agent-native-app-design.md`.
