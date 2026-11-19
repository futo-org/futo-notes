### Desktop editor: links and wikilinks _(desktop)_

What reads as a link, a web address or a wikilink, where a link goes and how a link edit is
written are the engine's ([portable-core/links.md](../portable-core/links.md),
[portable-core/wikilinks.md](../portable-core/wikilinks.md)); the editor draws its projection
and forwards each command. A link's `[`, `](url)` are hidden by the engine; a wikilink's whole
`[[target]]` is the engine's display text, which the page keeps as the text of one element
and draws as the engine's label.

- A link `[label](url)` shows only its label, in the link colour and underlined; a web address
  (`https://…`, `www.…`, `<https://…>`) shows as itself, linked. Formats inside a label draw
  as well (`[**bo**ld](u)`). A link typed by hand draws as one as soon as the engine reads it as
  one. → src/features/editor/desktop/lineLinks.ts `classedRuns`, desktopLinks.css,
  tests/desktop-editor-link-stories.mjs
- A wikilink shows the engine's label (the shortest unique suffix of the note id it resolves
  to: `[[Projects/Roadmap]]` shows "Roadmap") in the link colour with a dashed underline, its
  brackets hidden, no background. One that resolves to no note, or to several, shows its target
  as written, muted. Its label draws in the formats of the text around it (bold, italic,
  strikethrough), as a link's label does. Labels follow the vault: the note ids reach the engine
  when a note opens and again when the vault's notes change (a rename, a new note), and the
  lines whose labels that changed are drawn again. → lineLinks.ts `withWikilinks`,
  wikilinkElements.ts, lineSegments.ts `segmentsOf`, lineSegments.test.ts, noteIdDelivery.ts,
  attachedNote.ts `attach`, noteIdDelivery.test.ts
- A plain click on a link's own glyphs opens it when the button comes up, wrapped rows
  included; Mod+click and a middle click do too (the shell's tab rule: tabsStore
  `modeFromEvent`). Such a click moves no caret and selects nothing. A press that moves 4 px
  before it comes up is an ordinary press from where it began: it selects, a wikilink whole, and
  opens nothing. Blank space past a link is not its glyphs: a press there places the caret.
  Shift, Option, a double click and Ctrl+click on Apple never open. Separate clicks each open.
  → linkPress.ts, pointer.ts `down`
- A wikilink opens its note: the note it resolves to, else a note named by its target, which
  the shell creates as it opens and deletes again if it is left untouched
  (list/new-note.md). → DesktopEditor.svelte `openLink`, src/app/NotesShell.svelte `openNote`,
  src/features/notes/createNoteLoader.ts `noteToOpen`
- A link or a web address opens what the engine says its destination names: the note a
  schemeless destination names from the open note's folder, in the app as a wikilink's note
  opens (the same gestures and tabs; no note is created), else the address `external_link_url`
  answers, in the system's default browser or handler; anything else opens nothing. The page
  keeps no scheme list. → src/features/editor/desktop/linkTarget.ts, DesktopEditor.svelte
  `openLink`, src/lib/platform/openExternalUrl.ts, linkTarget.test.ts
- A plain click opens a web address in front; Mod+click and a middle click open it behind the
  window, as a browser's background tab. A debug build opens every one the dev build's way
  instead, behind the window in the developer's chosen browser (apps/tauri/AGENTS.md
  `dev_open_url.rs`), so an agent never pulls a browser over the developer. → linkTarget.ts
  `opensBehind`, openExternalUrl.ts `openPressedLink`,
  apps/tauri/src-tauri/src/open_url_behind.rs

> **Gap:** _(Windows, Linux)_ Mod+click and a middle click open the address in front: those
> systems give no dependable way to open a browser behind the window. →
> apps/tauri/src-tauri/src/open_url_behind.rs

> **Gap:** An `sms:` link reaches the platform opener (`state.opened` names it) but opens
> nothing: the opener plugin's default permission and the host's own openers allow only
> `http`, `https`, `mailto` and `tel`. → apps/tauri/src-tauri/capabilities/default.json,
> apps/tauri/src-tauri/src/open_url_behind.rs

- A letter typed at the very start or end of a link's label is outside the link: a caret put at
  a link's edge, by any move but Left and Right at inline code's edge, takes the side outside it
  (the engine's affinity), so a link never grows at its edge. Between two links that touch
  there is no outside, and the caret keeps the ordinary rule. The caret gets inside a label by
  the arrow keys. → lineLinks.ts `outsideLinkEdge`, formats.ts `arrivalAffinity`,
  lineLinks.test.ts

> **Gap:** After Backspace takes a label's first letter, the engine answers the caret at the
> label's start on its inside, so the next letter joins the link. The page does not move an
> edit's caret. → crates/futo-notes-editor (the affinity an edit answers)

- A wikilink is one unit: the caret never stands inside it. Left and Right step over it, and
  with Shift take it whole; a selection the user makes that ends inside one (a word motion, Up
  and Down, a drag) ends at its edge, on the side it was going; a press on it, once it drags,
  takes it whole. Backspace after it or Delete before it deletes it whole, one Undo step, and
  a deletion that cuts one (a word delete) takes it whole: the engine's rule
  (portable-core/wikilinks.md), the page only sends the key. A wikilink being typed (a `[[` run open
  in it) is not yet one: it draws as typed until the caret leaves it (paired-typing.md). Its
  own text never wraps apart from its label, so the caret before it stands where its label
  starts, on the next row when the label starts there; selected, a label that wraps is
  highlighted on each of its rows. → desktopLinks.css, highlight.ts `selectedBands`,
  tests/desktop-editor-link-stories.mjs
  → wikilinkUnit.ts, keys.ts `acrossAtom`, input.ts, selection.ts `sync`, hitTest.ts
  `atomHit`, wikilinkUnit.test.ts
- The selection toolbar ends with Link, after Code; it is lit when the selection lies in one
  link (the engine's `inspect_link`), and disabled where the engine's `toolbar_state` leaves
  Link out of `allowed` (a wikilink, inline code), where Mod+K does nothing too. Link and
  Mod+K open the Link prompt: a URL field with Add
  or Update, below the selection's start inside the window; the field has focus as it opens, so
  an address is typed or pasted at once. In a link (a caret inside it, or a
  selection within it) the field holds the link's destination, and Update sets it on the whole
  link; an empty field removes the link and keeps its text. Over a selection Add links it (the
  engine's rules: one link per line, a link inside taken off first). At a plain caret Add
  inserts the address as its own label, the caret after it; an empty field there does nothing.
  The destination saved is the engine's `normalize_link_destination` of what was typed, from
  the open note (`example.com` is saved as `https://example.com`, a note path as typed).
  Enter is Add or Update; Escape or a press outside the field cancels, the note as it was. Each
  edit is one Undo step. → linkPrompt.ts, FormatToolbar.svelte, keys.ts,
  src/features/editor/milkdown/linkPrompt/LinkUrlField.svelte
- The Link prompt belongs to the note and the version it opened on: opening another note
  closes it, and a submit after any edit to the note since does nothing. → linkPrompt.ts
- Typing `[[` lists, under the caret, the notes whose id holds what is typed after it, as the
  engine offers them (up to 20, each by its label, with its full id under it when that differs),
  narrowed as the typing goes on. Up and Down move the highlight; Enter or Tab writes
  `[[full/id]]` in place of what was typed (an `]]` right after the caret included) and puts
  the caret after it, one Undo step, before a list item, a task or a table takes the key; a
  press on a row does the same. Escape closes the list and keeps what was typed; it stays
  closed while that `[[` is typed on and opens again for another. No list shows for a run no
  note matches, during a composition, for a selection or without focus; it offers no new note
  and no alias. → wikilinkCompletion.ts, caretList.ts, keys.ts `keyDown`,
  wikilinkCompletion.test.ts
