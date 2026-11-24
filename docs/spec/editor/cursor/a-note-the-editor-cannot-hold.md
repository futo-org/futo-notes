### A note the editor cannot hold

- Malformed Markdown never makes a note unopenable: unclosed fences, emphasis or
  links, a lone CR or a NUL open editable with their exact source, and opening
  and saving without an edit changes no bytes (portable-core/foreign-content.md).
- An editor that has never been handed a note reports "no content at all"
  (`undefined`), not an empty note. A replaced component — a dev hot reload
  today, any `{#key}`/`{#if}` around the editor tomorrow — mounts empty under a
  session that still holds the note, and `''` there is what truncated three real
  notes on 2026-09-03. The desktop shell re-hands the open note to every editor
  that mounts, so the reader gets it back. _(desktop)_ →
  src/features/editor/desktop/DesktopEditor.svelte `getContent`, `onmount`,
  src/app/createEditorMountReattach.ts, src/features/notes/noteSession.svelte.ts
  `reattachEditor`, src/app/createEditorMountReattach.test.ts
