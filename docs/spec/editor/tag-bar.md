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
  (which commits through a full re-serialization). Only a `_` the parser would
  read as an emphasis delimiter is escaped (`\_not em_`), so `_em_` still
  round-trips as emphasis (written `*em*`) and a `_` between spaces stays bare
  (see "Markdown house style"). →
  packages/editor/src/markdown/choose.ts,
  tests/editor-embed-milkdown-parity.spec.ts, tests/tags.spec.ts
