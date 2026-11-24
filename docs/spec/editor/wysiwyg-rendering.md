## WYSIWYG rendering

- The editor shows RENDERED Markdown, never its source. Markers (`*`, `#`,
  ` ``` `, `[[`, `]]`, …) are hidden by the engine's display text, so no
  caret movement reveals them: there is nothing to reveal. →
  desktop/editing.md, src/features/editor/desktop/view.ts
- Opening a note and leaving it again leaves the file byte-identical: the
  engine session keeps the note's own bytes, and only an edit changes them. →
  portable-core/linedown.md, desktop/editing.md
- An object whose source is hidden — a thematic break, an image, a wikilink — is
  one unit, reached by SELECTING it whole (Backspace or Delete beside it takes it
  whole), which is how it can be deleted or replaced at all in an editor that
  shows no source. Front matter is never selected on its own: it is not edited
  (markdown-elements.md "YAML front matter"). →
  src/features/editor/desktop/atomElements.ts, portable-core/images.md,
  portable-core/wikilinks.md
