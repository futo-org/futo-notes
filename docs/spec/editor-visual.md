# Editor — Visual Spec

How the Markdown editor **looks and is laid out**. This is the visual companion
to `editor.md`, which owns editor behavior.

## Reading column

- Blockquote bars and code-block backgrounds stop at the reading column; they do
  not paint into the editor's left padding _(desktop)_. →
  `src/features/editor/desktop/desktopEditor.css`, `desktopCodeBlocks.css`
