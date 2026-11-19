### Desktop editor: the selection toolbar _(desktop)_

A floating bar over a selection offers the heading levels, Quote and the inline formats. Each
button runs the engine's command and lights from the engine's reading of the selection; the
page holds no format rule of its own.

- A non-empty selection in the focused editor shows the selection toolbar: Heading 1, Heading
  2, Heading 3 and Quote, a separator, then Bold, Italic, Strikethrough, Code and Link
  ([links.md](links.md)). There is no
  Text button: a lit heading level turns its lines back to text. Centred above the selection's
  first row, or below its last when the pane has no room above, inside the pane and never over
  the selected text (with no room either side it hides); it scrolls with the text. In a pane
  narrower than the bar its buttons wrap onto a second row. It does not show for a caret, a
  selection of only whitespace and line breaks, over code (code-blocks.md), while a press
  drags, during a composition, or while the editor has no focus. A press keeps the editor's
  focus and selection, and is one Undo step. → src/features/editor/desktop/FormatToolbar.svelte,
  overlays.ts `toolbar`, tests/desktop-editor-toolbar-stories.mjs
- An inline format button is lit when the selection has its format, read from the engine (its
  `active_formats`, the rule in portable-core/inline-formatting.md: inline code does not count
  for Bold, Italic and Strike); a mixed selection is unlit, and pressing makes all of it that
  format; pressing a lit one turns the format off. A button, Link included, is disabled
  where the engine's `toolbar_state` leaves its command out of `allowed` (it would change
  nothing: inside inline code, over a wikilink, or where no spelling can open, as Strike over
  bold that starts mid-word); a press there does nothing. Its state follows every selection
  change and edit, from the one `toolbar_state` read per selection (formatting.ts `formats`).
  → formats.ts `formatButtons`, formatting.test.ts, tests/desktop-editor-format-stories.mjs
- A heading button runs the engine's `ToggleHeading` on the selection's lines: when every
  touched line with text has that level they become text, otherwise they take it. Quote runs
  the engine's `Quote`: a level off when every touched line with text is quoted, otherwise a
  level on. Code lines, front matter and dividers are left alone, so a selection from text
  through a code block changes only its text lines; list items and tasks take a heading
  without their marker and a quote with it (portable-core/block-commands.md). The block
  buttons stay enabled inside inline code. → blockButtons.ts, formatting.ts `block`,
  blockButtons.test.ts

- A heading button is lit when every touched line with text has that level, and Quote when
  it would take a quote level off; the heading buttons are disabled where no heading can apply
  to any touched line, and Quote where it can change none (only table lines, code, front matter
  or dividers). The page reads this from the engine's `toolbar_state`
  (portable-core/block-commands.md) and holds no rule of its own. → formatting.ts
  `formatsOf`, blockButtons.ts, blockButtons.test.ts, tests/desktop-editor-toolbar-stories.mjs
- Over a selection from text through a table, Bold, Italic, Strikethrough, Code, Link and Quote
  change the text lines and leave every table line's bytes as they were (the engine's rule:
  portable-core/inline-formatting.md, block-commands.md). → tests/desktop-editor-toolbar-stories.mjs
