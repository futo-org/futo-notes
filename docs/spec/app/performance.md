## Performance

- Book-length notes must stay responsive. On the open path an unbounded
  synchronous full-document parse is banned: a note of 400 lines or more is
  parsed in top-level chunks, the first of which mounts synchronously so the
  first viewport is interactive, with the rest streamed in idle slices. Budgets
  and the streaming rules live in [editor.md](../editor.md) "Performance". →
  src/features/editor/milkdown/progressiveLoad.ts,
  src/features/editor/milkdown/markdownChunks.ts
