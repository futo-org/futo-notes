# Note List — Spec

The home screen: notes in the current folder, a folder drawer, and search /
new-note affordances.

## List

- Shows the notes in the current folder, or all notes when "All notes" is
  selected. → NoteListScreen.kt
- Notes are sorted most-recently-modified first. **Opening a note does not count
  as modifying it** — only an actual content or title change moves a note to the
  top.
- Tapping a note opens it in the editor (no autofocus). → NoteListScreen.kt /
  MainActivity.kt
- An empty folder shows an empty state ("Nothing here yet").
- The top bar is transparent at rest and gains a surface fill + bottom border
  once the list is scrolled. *(Android)*

## Folder drawer

- Opened from the menu icon (or an edge swipe). Lists "All notes" first, then
  each folder path, each with a live note count. → NoteListScreen.kt
- Selecting a folder filters the list and closes the drawer.
- A Settings entry sits at the bottom of the drawer.

## New note

- The FAB creates an "Untitled" note in the current folder (the vault root when
  "All notes" is selected) and opens it with the title autofocused. →
  NoteListScreen.kt
