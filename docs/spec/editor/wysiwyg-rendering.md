## WYSIWYG rendering

- The editor shows RENDERED Markdown, never its source. Markers (`*`, `#`,
  ` ``` `, `[[`, `]]`, …) are parsed into document structure on open and written
  back on save, so no caret movement reveals them: there is nothing to reveal.
  → src/features/editor/milkdown/MilkdownEditor.svelte,
  packages/editor/src/milkdown-compat/
- Opening a note and leaving it again leaves the file byte-identical. While the
  document is still exactly what loaded, the editor hands the host back the
  bytes it was given rather than its own serialization; the FIRST real edit is
  what re-spells the note, and it re-spells the whole note (ADR-0002,
  normalize-once). → milkdown/hostHandle.ts `getContent`,
  docs/adr/0002-roundtrip-normalization-accepted.md,
  tests/editor-embed-milkdown.spec.ts
- A block with no text of its own — a thematic break, a wikilink chip, the front
  matter panel — is reached by SELECTING it, which is how it can be deleted or
  replaced at all in an editor that shows no source. →
  src/features/editor/milkdown/wikilink/node.ts,
  packages/editor/src/milkdown-compat/frontmatter.ts
- An empty paragraph — a third Enter, on the empty line the second one left —
  is spelled in the file as an EXTRA
  blank line, never as HTML: `N` empty paragraphs between two blocks save as
  `N + 1` blank lines, and `N` blank lines between two blocks load as `N - 1`
  empty paragraphs, so the gap survives a reload and the second save is a fixed
  point. Blank lines before the first block are kept the same way; blank lines
  at the very end of a note are not (a trailing empty paragraph is dropped on
  save). Milkdown's own spelling, a literal `<br />` on a line of its own, is
  never written; one an older build wrote loads as the single empty paragraph it
  stood for and is re-spelled as blank lines on the note's first real edit
  (ADR-0002). An author's inline `<br>` beside text is untouched. Two lists with
  an empty paragraph between them keep different markers (`-` then `*`, `1.`
  then `1)`) so the blank line does not merge them into one list; the empty
  paragraph the schema itself puts in front of a list item whose content is a
  block (`- > quote`) is never written. →
  packages/editor/src/milkdown-compat/emptyLine.ts (load),
  packages/editor/src/markdown/serializer.ts `joinDocument`/`planDocument`,
  packages/editor/src/markdown/blocks.ts `writeItem`,
  tests/editor-embed-milkdown-compat.spec.ts
- Progressive open preserves those gaps across chunk seams: the blank run a cut
  leaves at the end of one chunk is counted by the loader and re-inserted as
  empty paragraphs in front of the next, so a note opened in chunks is the same
  document as the note opened whole. →
  src/features/editor/milkdown/progressiveLoad.ts `seamEmptyParagraphs`
