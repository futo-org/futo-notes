## Tag bar _(desktop)_

The tag bar is a **desktop-only surface by decision (2026-06-09)** — mobile
native shells edit tags as text in the body, which is not a gap.

- A tag bar sits between the title and the editor: one chip per current tag,
  plus a "+ Tag" affordance. → NoteTagBar.svelte
- "+ Tag" opens an inline input with autocomplete over the vault's existing
  tags (case-insensitive); a non-matching entry shows a "Create #name" option.
  Enter or comma commits.
- Committing a tag writes it into the note's **leading header tag block**
  (creating the block when absent) — the tag is note content, not metadata.
- Removing a chip removes the tag; removing the last tag removes the entire
  header block.

- An underscore INSIDE a word survives a save unescaped: `#dog_problems`,
  `snake_case_word` and `file_name.txt` are written back exactly, on every
  platform, whether the edit came from the keyboard or from the desktop tag bar
  (which writes through the engine's header tag commands: desktop/tags.md). The
  engine keeps the note's own bytes, so nothing a save writes is escaped or
  re-spelled (portable-core/linedown.md). →
  tests/tags.spec.ts "Tag input normalizes case and spaces before creating"
