### A note the editor cannot hold

- A note whose markdown makes the parser throw is shown READ-ONLY with a visible
  "This note could not be displayed" message, never as a blank editable page. →
  src/features/editor/milkdown/documentSession.svelte.ts `loadFailed`,
  src/features/editor/milkdown/MilkdownEditor.test.ts
- For such a note the editor reports the HOST's original bytes as its content —
  the same load-echo contract as an unedited note (ADR-0002), extended to the
  case where the document is not the note at all — emits no change, and refuses
  chrome edits (tag bar, toolbar insertions). The file is never rewritten. →
  milkdown/hostHandle.ts `getContent`, `applyEdit`, `insertMarkdown`
- The next note that parses clears the state completely: editable again, no
  message, its own content reported.
- An editor instance that has never been handed a note reports "no content at
  all" (`undefined`), not an empty note. A replaced component — a dev hot
  reload today, any `{#key}`/`{#if}` around the editor tomorrow — mounts empty
  under a session that still holds the note, and `''` there is what truncated
  three real notes on 2026-09-03. The desktop shell also re-hands the open note
  to a new instance, so the reader gets it back. → milkdown/hostHandle.ts
  `getContent`, NotesShell.svelte, noteSession.svelte.ts `reattachEditor`
