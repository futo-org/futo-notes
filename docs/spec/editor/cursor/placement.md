### Placement

- Tapping text places the caret at the tapped character. →
  src/features/editor/milkdown/MilkdownEditor.svelte
- Caret placement, arrow motion, word/paragraph selection on multi-tap, and
  drag-selection are the PLATFORM's own: the editor runs no pointer hit-testing
  or cursor-motion code of its own. (The CodeMirror editor did, because a
  live-preview document has hidden source a native hit test would place a caret
  inside; there is no hidden source here.)

- Pressing Enter in a continued list item scrolls the new item into view. →
  docs/learnings/ios-keyboard-editor-jump.md _(iOS)_
