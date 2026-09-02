# Editor — Visual Spec

How the Markdown editor **looks and is laid out**. This is the visual companion
to `editor.md`, which owns editor behavior.

## Reading column

- Blockquote bars and code-block backgrounds stop at the reading column; they do
  not paint through the editor's larger left gutter (the one the ⠿ block-drag
  handle floats in on desktop). →
  `src/features/editor/milkdown/MilkdownEditor.svelte`
  `.ProseMirror blockquote` / `.ProseMirror pre`
