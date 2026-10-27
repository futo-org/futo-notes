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
opens an unsaved buffer: `screen` is `editor:new` and `state.note` is `null`
until you `SetTitle` (or it autosaves as `Untitled (N)`), after which `screen`
becomes `editor:<title>`.

**The editor** is Milkdown, a ProseMirror document: blocks (paragraphs, headings, list
items, table cells, code) holding text with marks (bold, links) and inline objects (wikilink
chips, images). Positions are ProseMirror's own: each character is one, each block boundary
one more, so a line's caret positions run from its `at` to its `end` and the gap between two
lines holds none. A chip is one position, however long its text. `state.editor` reports
`note` (the path of the note it holds), `onScreen` (which lines show), `loading`, `docVersion`, `focused`, `ready`, `find`, and `selection` with
`from`/`to`, `anchor`/`head`, `line`/`col`, the selected `text`, a `kind` when it is not a text
range (`node hr`, `cells`), and `formats`: what the toolbar shows as on there (`bold`,
`heading-1`, `task-list`). Opening a note leaves the caret at its end.

**Formatting verbs read the selection.** `Bold`, `Heading`, `CodeBlock`, … act
on the selection or the caret's line, exactly as the toolbar would. `Select`
first, then the verb.

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
- **The first edit rewrites the note in the editor's markdown.** An untouched note saves its
  own bytes; after any edit the whole note is re-spelled in the house style (docs/spec/editor.md
  "Markdown house style"): a rule as `---`, list markers and padding the style's own, and an
  escape only where the parser needs one. `md` and the receipt's `doc` hunk are already in that
  form, so they show only what changed.
- **A vanished sidebar row is not a deletion.** The tree draws nothing inside a
  collapsed folder, so a note can be in the vault with no row.
  `notes` is the vault itself — use it to confirm a move, rename or delete
  instead of reading the tree. (Deleting a folder's last note does delete the
  folder, so that row really is gone.)
- **A new note is named by the autosave, not by your verb.** After desktop
  `CreateNote` plus a first `Type`, `state.note` stays `null` and `screen`
  stays `editor:new` until the debounced save mints the id: poll `state` again
  rather than treating the first answer as final. `SetTitle` settles on the
  rename and is the way to name it deliberately.
- **What you type is not always what lands.** `Type` delivers a `\n` as the Enter
  KEY and every character through the editor's input rules, so `# ` makes a heading,
  `- ` a bullet, `---` a divider, and Enter inside a list continues it — which is what it
  does to a person. That is the point of `Type` when typing is what you are checking; to
  just put text in a document, the fast writes (`AppendLine`, `InsertLine`, …) read it as
  markdown in one step.

## Gaps to know about

- **A phone's page queries refuse off the editor screen**, rather than answering about
  the note the webview still holds: `doc`, `at`, `events`, `diff` and `show {"text"}` are
  409 from `list` or a folder, where `elements` and `show {"ref"}` read the native rows.
  `state`, `notes`, `search` and `clipboard` answer everywhere.
- Desktop real input (`click`, `drag`, `scroll`, `type`, `press`) is handed by the app to its
  own web view, on macOS, Linux and Windows alike. `tap` on desktop refuses and
  names `click`; `click` on a phone refuses and names `tap`. The window need not be focused
  and is never activated, so `state.editor.focused` and `document.hasFocus()` stay false
  while the human is elsewhere; DOM focus still moves, which is what focus bugs are about.
- A desktop `drag` that starts on selected text stays a selection drag: the trace bracket
  cancels `dragstart`, because an OS drag-and-drop begun by synthesized events can only be
  ended by a real mouse-up and wedges the window until then. Text drag-and-drop is therefore
  the one mouse behaviour `drag` cannot exercise.
- `do` from raw `curl` skips the pending poll, the target vetting and the trace
  file. Use the CLI.

Design record: `docs/research/agent-native-app-design.md`.
