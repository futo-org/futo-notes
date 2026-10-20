### Blank editor surface

- Blank space beside lines and below the final line is part of the editor: the
  editable element IS the scroller, and its gutters and its tail belong to it,
  so a press there places a caret rather than falling through to the shell. →
  src/features/editor/milkdown/milkdownEditor.css `.ProseMirror`
- The editable element fills the whole note area in BOTH axes, however little
  the note holds: it is never sized to its own content. A box sized to its
  content leaves the space it fails to reach owned by no one — the desktop
  shell's deselect zone ignores presses on a descendant — so that space would
  place no caret, take no focus, and swallow the press entirely. → src/features/
  editor/milkdown/milkdownEditor.css `.milkdown` / `.ProseMirror` _(desktop)_
- The body's first character sits under the title's first character: the
  860px editor column is 60px wider than the 740px title column on each side,
  and the body's left padding is that 60px plus the title's 20px. The ⠿ handle
  floats inside that padding. _(desktop)_ → src/features/editor/milkdown/
  milkdownEditor.css `.desktop-layout .ProseMirror`, tests/p2-regressions.spec.ts
- An empty note is therefore fully typeable: it holds one empty paragraph, and
  a press ANYWHERE in the note area places the caret in it. This is the state
  every new note starts in. → tests/p0-regressions.spec.ts "Empty-note caret",
  tests/editor-embed-milkdown.spec.ts
- The tag bar's blank space reaches the first line of the editor at the
  pointer's column: pressing it focuses the editor and places the caret at that
  x on the first line. Tag controls and the title keep their own interactions.
  → NoteWorkspace.svelte `reachFromTagBar`, milkdown/hostHandle.ts
  `placeCaretAtCoords`
- A primary press outside the desktop editor surface deselects the note without
  moving its caret and commits a pending title rename; movement during that
  press does not turn it into a text-selection drag. → NoteWorkspace.svelte
  `handleNoteBodyMouseDown` _(desktop)_
