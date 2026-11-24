## WYSIWYG rendering

- The editor shows RENDERED Markdown, never its source. Markers (`*`, `#`,
  ` ``` `, `[[`, `]]`, …) are hidden by the engine's display text, so no
  caret movement reveals them: there is nothing to reveal. →
  desktop/editing.md, src/features/editor/desktop/view.ts
- Opening a note and leaving it again leaves the file byte-identical: the
  engine session keeps the note's own bytes, and only an edit changes them. →
  portable-core/linedown.md, desktop/editing.md
- A block with no text of its own — a thematic break, a wikilink, the front
  matter panel — is reached by SELECTING it, which is how it can be deleted or
  replaced at all in an editor that shows no source. →
  src/features/editor/desktop/atomElements.ts, desktop/tags.md
