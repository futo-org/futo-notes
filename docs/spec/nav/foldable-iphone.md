## Foldable iPhone _(iOS)_

The iPhone Duo's windows: closed 466 × 678 pt (upright) or 678 × 466 (landscape); open
669 × 951 (tall) or 951 × 669 (held like a book). Intentional iOS-only surface: Android has
no foldable layout, not a gap.

- A phone window gets the **pages shell** when both sides are at least 600 pt (the open
  Duo), or when it is landscape, at least 640 pt wide and squatter than 1.6 : 1 (the closed
  Duo held sideways). Every other iPhone window, upright or sideways, keeps the phone
  stack, and iPad keeps its stack at every size. → ShellLayout.swift `ShellLayout`,
  DuoPagesLayoutTests
- Both shells read the one navigation path: the last folder on it is the folder the
  pages shell's list shows, and the notes after it are its editor pane's stack (the first
  is the pane's root, later ones are wikilink pushes Back walks). → DuoPagesView.swift
  `PagesPath`
- Open and held like a book, a folder column (170 pt) and the folder's notes share the
  left page and the note owns the right page; the split lands on the hinge, so nothing
  crosses the fold. → DuoPagesView.swift `PagesFrames`
- Open and held tall, the list sits beside the note; the list title's menu switches
  folder, and Sync, New folder and Settings sit in the list's footer.
- Half-folded, a 16 pt gutter covers the crease. Held tall and half-folded (tabletop),
  the note takes the upright half and the list the flat half, where the keyboard comes
  up; the note's frame never reaches the flat half, so it does not move for the keyboard.
  → HingeReader.swift (`UIHingeInteraction`, iOS 27.1)
- Closed and held sideways, a narrow list sits beside the note.
- Closed and upright, the phone stack shows denser rows: two preview lines, and a first
  preview line that only repeats the title is dropped. → NoteRow.swift, `NotePreviewText`
- Changing posture or rotating moves the panes without rebuilding them, so the open note
  keeps its editor. Folding or unfolding swaps shells: the open note leaves the way Back
  makes it (saving and releasing its session) and reopens in the new shell, by its current
  id if it was renamed or moved meanwhile. → RootShell.swift `resize(to:)`
- The keyboard never counts as a smaller window, so it cannot change the layout under
  the caret. → RootShell.swift `measuredShell`
- Picking a note in the list opens it in the editor pane and highlights its row; the
  highlight follows a rename. Opening another note saves and closes the one showing.

> **Gap (iOS):** the debug puppet listener's `OpenNote` and `OpenFolder` verbs assume the
> phone stack's one-screen-at-a-time shape, so in the pages shell `OpenNote` refuses while
> an editor is showing beside the list. A person's taps work.
