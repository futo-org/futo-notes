## New note

- **New note and New folder are two separate one-tap controls on every
  platform** (github#5: a "+" that opened a menu put quick capture behind an
  extra tap). Desktop: the "+ New" button and its folder-icon sibling
  (SidebarCreateActions.svelte). Android: the "+" FAB is a plain "New note" and a
  folder-plus action icon ("New folder") sits in the top app bar before Search
  and Settings (the Material 3 home for a secondary create action; a stacked
  small FAB was tried and rejected as a non-M3 speed dial). iOS: a folder-badge-plus
  button and a compose button side by side in the trailing nav bar. Neither
  shell has a create menu any more. → SidebarCreateActions.svelte,
  NoteListScreen.kt, NoteListView.swift
- The New-note control creates an "Untitled" note in the folder being browsed
  (the vault root on the root screen) and opens it with the **body** focused for
  quick capture (keyboard on the note text, not the title). The New-folder
  control likewise creates in the folder being browsed, so both are reachable at
  every depth. → NoteListScreen.kt, NoteListView.swift
- On mobile-width shells, "+ New" opens the note with the **title** focused and
  "Untitled" select-all'd so typing replaces it immediately. Desktop keeps body
  focus; the wikilink-to-missing-note create path keeps body focus everywhere.
  → noteSession.svelte.ts `loadNote('new')`, NotesShell.svelte `focusTitle`
