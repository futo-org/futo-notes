### Desktop editor: tags and front matter _(desktop)_

What a tag is, what the header tag block is, how a header tag edit is written and what front
matter is are the engine's ([portable-core/tags.md](../portable-core/tags.md),
[portable-core/foreign-content.md](../portable-core/foreign-content.md)); the editor draws its
projection and forwards each tag bar edit to it. The tag bar itself is
[tag-bar.md](../tag-bar.md).

- A `#tag` the engine reports shows in the primary colour and nothing else: no box, no
  background, its text as written, so the caret, the selection and typing treat it as any other
  text and typing in one never shifts the line. Where the engine reports none (inline code,
  fenced code, front matter, a tag the grammar refuses) nothing is coloured. A click on a tag
  places the caret, as on any text. → src/features/editor/desktop/lineTags.ts,
  lineLinks.ts `classedRuns`, desktopTags.css, lineTags.test.ts
- The header tag block stays in the note as ordinary text, its tags coloured, while the tag
  bar shows the same tags as chips. → tags.md (TG03)
- The tag bar's chips are the engine's `header_tags`, read when a note opens and with each
  reported change. Adding a tag (Enter, a comma, a suggestion, "Create") is the engine's
  `add_header_tag` and removing a chip is its `remove_header_tag`: each is one edit and one
  Undo step through the editor's input path, so it is saved, undone and reported idle as typing
  is. The note's caret and selection stay on their text and the pane does not scroll. The bar
  never writes Markdown itself. → src/features/editor/desktop/headerTagEdits.ts,
  src/features/editor/NoteTagBar.svelte, headerTagEdits.test.ts, NoteTagBar.svelte.test.ts
- After a tag is added the field stays, emptied and focused, for the next one. Enter with
  nothing typed and Escape close it and give the note focus, so the next key (Undo included)
  is the note's; a press elsewhere closes it and takes focus where it pressed. →
  NoteTagBar.svelte `returnToNote`, src/app/components/NoteWorkspace.svelte,
  NoteTagBar.svelte.test.ts, tests/desktop-editor-tag-stories.mjs
- A tag being typed in the bar belongs to the note it was started on: when another note opens
  (or the same note is read again from disk) the field closes and nothing is added to either.
  → NoteTagBar.svelte, headerTagEdits.ts `createHeaderTagEdits`
- With the vault unusable, or no note open, the bar shows the tags without add or remove.
  → src/app/components/NoteWorkspace.svelte
- Front matter shows as an inert metadata panel above the body: its fences hidden, each of its
  lines as written in the editor's monospace face, muted, on a tint with a left rule (both
  translucent, so a selection over it shows). The caret never rests in it: a caret the user places there (a click, a key's move) lands
  at the body's start (the engine's `place_selection`). → src/features/editor/desktop/lineElements.ts
  `lineClass`, desktopTags.css, lineTags.test.ts
- 8px of plain page stand between the panel and the first body line under it: the panel's last
  line's padding, its tint and rule stopping above it, so a press in the gap lands on that line.
  → blockNeighbours.ts, desktopTags.css, blockNeighbours.test.ts

> **Gap:** In a note that ends on front matter's closing `---` (no line after it), the engine
> describes the one empty line it shows for the body as front matter (`metadata`), so the caret
> stands in the panel's last row. → crates/futo-notes-editor (the block description of that line)
