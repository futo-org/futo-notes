### Desktop editor: find in note _(desktop)_

Find in the desktop editor is the engine's find ([portable find](../portable-core/find.md)):
the engine decides what matches, which match is current and where a step goes; the page opens
it, draws what it reports and scrolls to its current match. Find never edits the note or adds
an Undo step.

- Ctrl/Cmd+F opens the find bar over the bottom of the note pane, its query focused and
  selected: the selection's text when the selection lies within one line, else the query find
  last had in this note. With the bar open it focuses and selects the query again. A Home tab
  or the open search popup leaves the chord to them. → src/app/NotesShell.svelte,
  src/features/editor/desktop/findInNote.ts `open`
- The bar shows the query, the count (`3 of 17`, a red `0` with stepping disabled), previous,
  next and close; it is the desktop find bar (FindPanel.svelte), which holds no find logic.
  → src/features/editor/desktop/FindPanel.svelte
- Matching is the engine's: case-insensitive literal text as displayed, hidden markers and link
  destinations not found, every line break a barrier (a query never runs from one line to the
  next), table cells only, code text found, a code block's language and name never (they are
  not note text). → crates/futo-notes-editor/src/engine/commands/find.rs
- Changing the query scans once (one scan a frame while the query is typed) and makes the
  first match at or after the selection current, highlights it distinctly and scrolls it into
  view; the note's selection does not move. → findInNote.ts `setQuery`
- Enter, Shift+Enter, the bar's arrows and Ctrl/Cmd+G / Ctrl/Cmd+Shift+G step: the first press
  after the query changed selects the current match, later presses step from it to the next or
  previous one, wrapping. Ctrl/Cmd+G steps wherever focus is while the bar is open and does
  nothing while it is closed; zero matches and composition make a press do nothing. The
  selection toolbar stays down while the bar is open.
  → findInNote.ts `step`, src/app/registerNotesShellShortcuts.ts
- Every match on the lines near the screen is drawn as a band behind the text, the current one
  darker; the lines themselves are never changed for find. A revealed match is kept clear of
  the bar. Bands are hidden while an input method composes. → findBands.ts, desktopFind.css
- Editing with the bar open keeps it open: the bands follow the edit at once, and the note is
  scanned again 150 ms after input settles, so the count may lag an edit. Typing in the note
  never scans it. → findInNote.ts `edited`
- Escape in the query field or the bar's × closes it: every band goes, the caret is left at
  the current match's end with nothing selected, and the editor takes focus back. The query is
  kept for the next open of this note. → findInNote.ts `close`, overlays.ts
- Opening another note, or the note being read back from disk, closes the bar.
- There is no replace, regex, case or whole-word option, and cross-note search never seeds
  find.
