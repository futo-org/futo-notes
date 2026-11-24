### Blank editor surface

- Blank space beside lines and below the final line is part of the editor: the
  editable element IS the scroller, and its gutters and its tail belong to it,
  so a press there places a caret rather than falling through to the shell. →
  src/features/editor/desktop/desktopEditor.css `.desktop-editor`
- The editable element fills the whole note area in BOTH axes, however little
  the note holds: it is never sized to its own content. A box sized to its
  content leaves the space it fails to reach to the chrome, so a press there
  would take the caret away instead of placing one. →
  src/features/editor/desktop/desktopEditor.css `.desktop-editor-wrap` / `.desktop-editor` _(desktop)_
- The body's first character sits under the title's first character at every
  window width: the 740px title column is centred in the 860px editor column,
  and the body's left padding follows the title's text edge, down to the
  title's own 20px once the window is narrower than the column. _(desktop)_ →
  src/features/editor/desktop/desktopEditor.css `.desktop-editor`
- An empty note is therefore fully typeable: it holds one empty paragraph, and
  a press ANYWHERE in the note area places the caret in it. This is the state
  every new note starts in. → tests/p0-regressions.spec.ts "Empty-note caret"
- A press on the chrome around the editor, where the arrow cursor shows (the
  title row's slack, the tag bar's blank space), takes focus off the editor: its
  caret goes, keys typed next do not reach the note, and a pending title rename
  commits as the title loses focus. The engine keeps the selection, so the caret
  comes back where it was when the editor takes focus again. →
  src/features/editor/desktop/view.ts `focusChange` _(desktop)_
