## Wikilinks — navigation & integrity

Parsing and note-tree rules are shared. Web rendering details describe desktop; native
interactions follow [mobile links](mobile/lists.md) and [native exits](editor-exits.md).

- A web wikilink displays the shortest unique path suffix (`[[Projects/Roadmap]]` renders as “Roadmap” while unambiguous). → tests/editor-embed-milkdown-wikilinks.spec.ts

- `[[`…`]]` is a wikilink when it holds at least one character that is neither a
  line ending nor the start of `]]`; the whole inner text is the target. A `!`
  immediately in front of one (`![[Note]]`, Obsidian's embed syntax) is **plain
  text followed by a wikilink** — the `!` is claimed as text so micromark's
  image label cannot swallow the `![` and leave the link escaped. **Everywhere
  else a `!` is ordinary text and begins nothing**: at the end of a line, at the
  end of the file with no trailing newline, inside a table cell (`| a | no!! |`),
  before a space, or before another `!`. The tokenizer decides this BEFORE it
  opens its token, so no path can strand one open — a stranded `wikilink` token
  stops the enclosing paragraph or table cell from closing, which threw on parse
  and opened the WHOLE note blank on every shell (issue #112, fixed
  2026-09-03). → src/features/editor/milkdown/wikilink/syntax.ts,
  src/features/editor/milkdown/wikilink/syntax.test.ts,
  tests/editor-embed-milkdown-wikilinks-autocomplete.spec.ts
- Clicking/tapping a wikilink navigates to the target note (desktop:
  Cmd/Ctrl+click opens it in a new tab; middle-click opens it in a background
  tab). Rapid clicks on separate links each navigate. → NotesShell.svelte
  onopenlink, milkdown/linkTaps.ts `handleLinkClick`
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path, **closes the `]]`, and drops the caret AFTER the link** (`[[Title]]|`)
  so typing continues past the link, not inside it (a bare change dispatch left
  the caret stranded after `[[`). Works on desktop and both native shells (same
  embed; verified on emulator + simulator 2026-06-09; caret-after-`]]` verified
  emulator + simulator 2026-07-08). The completion inserts the wikilink NODE and
  puts the selection just past it. →
  src/features/editor/milkdown/wikilink/autocomplete.ts,
  src/features/editor/wikilinkSuggestions.ts
- Autocomplete offers the note ids that contain the text typed after `[[` as a
  case-insensitive substring. Every Greek sigma folds to one letter, so `[[ΟΔΟΣ`
  offers `ΟΔΟΣΑ`; expanding lowercase characters are included, so `[[i` offers
  `İstanbul`. → src/features/editor/foldCase.ts,
  src/features/editor/wikilinkSuggestions.ts
- *(Android native text-first editor)* An open completion run shows an inline, scrollable list of existing-note candidates supplied by the engine; labels and full-id details render verbatim. Choosing a row accepts the canonical claim as one Undo step without changing neighboring source, while stale input, selection or attachment claims cannot edit another range or note. → apps/android/app/src/main/java/com/futo/notes/textfirst/EditorEngineCompletion.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstCompletions.kt
- *(Android native text-first editor)* Suggestions do not take input focus and are absent during marked composition or a noncollapsed selection. Close dismisses the same run during continued typing; leaving and returning to the run permits suggestions again. The delivered note catalog refreshes after vault changes, never per completion request. Completion offers no new-note creation, alias form or preview. → apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstCompletionTest.kt
- *(Android native text-first editor)* A wikilink longer than the viewport wraps across visual lines inside its span instead of clipping; the stored Markdown source is unchanged byte for byte. The caret and selection treat each whole link as one atom (no stop inside the raw `[[ ]]` text); a short tap on its drawn text on any of its visual lines follows it (a missing note is created, below); a tap beside the text on the same line, or on another line, does not. Verified on the emulator 2026-11-03 (3-line wrap, atom caret, reopen, tap fix). A wikilink inside a table cell still renders as its raw text in the cell grid. → `TextFirstLinkTest`, `TextFirstLinkTapTest`, `textfirst/TfSpanFactory.kt`
- *(Android native text-first editor)* A short tap on a wikilink no note answers (missing or ambiguous), on its drawn text, creates the note that wikilink's target names through the store, the path the list's new-note button uses (the store's title rule names the file and picks a free id), and opens it as a new note: the file exists while the note is open and is removed when the note is left with an empty, unedited body and its title unchanged, as a new note's is. A second tap while the first one's note is being made does nothing. The deferred create below stays the rule for the other platforms. → `textfirst/MissingWikilink.kt`, `textfirst/WikilinkTouch.kt`, `TextFirstMissingWikilinkTest`, `TextFirstMissingWikilinkTargetTest`
- A wikilink whose target does not resolve is still decorated, styled **broken**
  (`cm-md-link cm-md-wikilink cm-md-wikilink-broken`) — not undecorated, and
  **visually distinct from a resolved link** (muted/dimmed styling so a dead
  link is identifiable before you tap it). The
  resolver (`resolveWikilink`) treats an **ambiguous** target (a bare filename
  matching more than one note) exactly like an absent one: both return `null` and
  render broken. Tapping a broken wikilink opens an empty editor bound to the
  wikilink's target text as the title. On the native shells the note file is
  **created on the first edit/save**, not eagerly at navigation time — a
  **deferred** create-on-missing path (2026-07-11 decision). Desktop creates the
  file when the note opens, because its editor attaches only a note on disk, and
  deletes it again if the user leaves it untouched; the create follows an
  existence check, and a check that fails never creates. → src/features/editor/milkdown/wikilink/display.ts, wikilinks.ts
  `resolveWikilink`, createNoteLoader.ts, editor-embed/main.ts
- **Renaming or moving a note rewrites every wikilink that points at it,
  across all notes** — including folder moves (`[[Markdown demo]]` →
  `[[Archive/Markdown demo]]`) and **self-referencing links inside the renamed
  note's own body** (a note linking to itself must not be left with a silently
  broken link after its own rename). → wikilinks.ts rewrite rules,
  notes.svelte.ts `rewriteWikilinksForRename`
- The relink rules also live in the shared Rust crate
  (futo-notes-model `wikilinks::{resolve_wikilink, shortest_unique_suffix,
rewrite_wikilinks}` + `relink_note_references`), conformance-locked
  bit-for-bit against wikilinks.ts (tests/conformance/wikilinks-*.json). The
  native shells call the single `NoteStore.rename` or `NoteStore.moveNote`
  workflow, which moves the note and rewrites backlinks vault-wide under the
  store's workflow lock (verified on emulator + simulator 2026-06-09:
  bare-leaf and full-path links in other notes rewrote on disk).
  `[[target|alias]]` links are not rewritten — the TS rules treat the whole
  inner text as the target, and the Rust port pins that behavior. →
  futo-notes-wikilinks lib.rs, futo-notes-store `LocalNoteStore::rename`,
  futo-notes-ffi `NoteStore::{rename,move_note}`
