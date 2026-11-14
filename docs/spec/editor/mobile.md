# Native mobile text-first editor

Behaviors of the native text-first editor that iOS and Android share: the engine
(portable-core) rendered by native views, as opposed to the desktop WYSIWYG
editor. Lines here are *(mobile)*: true on iOS and Android alike.

- A line moves here from an *(Android text-first editor)* tag in the same commit
  that makes it pass on iOS. Until then it keeps its *(Android)* tag.
- A line that is truly platform-specific (a keyboard, gesture or OS service one
  platform has and the other lacks) keeps its *(iOS)* or *(Android)* tag.
- Engine behavior independent of any renderer belongs in
  [portable-core](portable-core.md), not here.

- *(mobile)* Debug and Release open notes in native Linedown views; editor availability is independent of the Debug identity and notes-root guards. → apps/ios/Sources/Notes/List/NoteListView.swift, apps/android/app/src/main/java/com/futo/notes/MainActivityShell.kt

The section files under `mobile/` are added as lines move.

- [Clipboard and system text actions](mobile/clipboard.md)
- [Toolbar state and commands](mobile/toolbar.md)
- [Heading keys](mobile/headings.md)
- [Lists, checkboxes and links](mobile/lists.md)
- [Images](mobile/images.md)
- [Tables](mobile/tables.md)
- [Find in note](mobile/find.md)
- [Long notes](mobile/long-notes.md)
