# Editor — Visual Spec

How the Markdown editor **looks and is laid out**. This is the visual companion
to `editor.md`, which owns editor behavior.

## Reading column

- Blockquote bars and code-block backgrounds stop at the reading column; they do
  not paint through the editor's larger invisible pointer gutter. →
  `src/styles/app-shell.css` `.cm-md-quote` `.cm-md-code-block`
