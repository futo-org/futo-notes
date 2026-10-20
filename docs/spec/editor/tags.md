## Tags

- A `#tag` is extracted and decorated only when it is at a word boundary, does
  not start with a digit, is within the max length, and is NOT inside inline
  code or a fenced block. A tag stays PLAIN TEXT in the document — it is neither
  a node nor a mark — and is decorated with colour only, so typing inside one
  never shifts the line. → packages/editor/src/tags.ts,
  src/features/editor/milkdown/tagDecorations.ts,
  src/features/editor/milkdown/tagDecorations.test.ts
- Tags dedup case-insensitively (`#Project` + `#project` → one `#project`).
- A leading header tag block is recognized as the note's tag block — it is what
  the desktop tag bar reads and writes — and it renders as ordinary text with its
  tags decorated. It is NOT hidden: a node rendered `display: none` cannot be
  reached by caret or click, so hiding it would leave the note's tags uneditable
  on the native shells, which have no tag bar, and a Backspace at the start of
  the following paragraph would silently join an unseen block. →
  src/features/editor/milkdown/tagDecorations.ts,
  docs/plan/milkdown-transition.md "T5 outcome"
