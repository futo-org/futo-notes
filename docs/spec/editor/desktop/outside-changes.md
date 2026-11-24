### Desktop editor: a change to the open note from outside _(desktop)_

What the desktop editor does when the open note's file changes while it holds it: sync wrote
it, another app edited, renamed or deleted it. The verdict is the shared classifier's
([remote edits to the open note](../../sync/polling/remote-edits-to-the-open-note.md)), for a
watcher event and a sync cycle alike; the saves are the editor host's
([saving & rename](../saving-and-rename.md)). This file says what the editor does with each
verdict.

- A clean editor takes the outside version in place: the host's save writes nothing and
  offers the source the file now holds, and the page adopts it as one edit that is not an Undo
  step and is not reported as typing. The caret stays with its text, and Undo keeps the user's
  own steps (rebased onto the change) and never undoes the outside change. → attachedNote.ts
  `landed`, takeOffer.ts, view.ts `showOutsideEdit`, editor_session/checkpoint.rs,
  attachedNote.test.ts, takeOffer.test.ts
- When the engine cannot rebase onto an outside change (a front matter change, the history
  bounds, an ambiguous step), the editor reads the note back from disk instead: the pane keeps
  its scroll, the caret starts at the note's start and Undo has nothing to undo. →
  DesktopEditor.svelte `reload`, keepPaneScroll.ts, editor_host.rs `reload`,
  keepPaneScroll.test.ts
- A clean editor that has focus takes the change at once. Only marked text (an input method
  composing) waits: the change is taken when composition ends, read from disk again then. A
  keystroke before that makes the draft dirty. → src/features/sync/createExternalChangeCoordinator.ts
  `captureEditor`, DesktopEditor.svelte `takeOutsideChange`, checkpointOrReload.ts
- An editor with unsaved edits is never replaced. Before the verdict is taken, for a watcher
  event and a sync cycle alike, the session saves the draft (with marked text up it waits, and
  the host's timer saves), and every save merges three ways: changes to different lines or words
  are written as one file and adopted into the draft as one edit that is not an Undo step, so
  Undo removes the user's own last edit and keeps the outside one. A draft typed past a merge it
  has not adopted merges again on its next save. → createExternalChangeCoordinator.ts
  `reconcileOpenNoteWithEngine`, editor_session/checkpoint.rs, attachedNote.ts `landed`
- Edits to the same words park the draft as a conflict copy: the original keeps the outside
  bytes, and the editor, its title and its tab follow the copy, with no toast. →
  editor_session/checkpoint.rs, noteSession.svelte.ts `followEditorNote`
- When the page cannot adopt a merge the store already wrote (a front matter change, the
  history bounds, an ambiguous step), the editor reads the note back from disk with Undo empty;
  the file holds both sides, so nothing is lost. → DesktopEditor.svelte `reload`,
  editor_host.rs `reload`
- A rename or move of the open note, made outside the app or by sync, moves the editor's
  attachment with the file; the editor keeps its draft, caret and Undo, and the session and
  tab follow the new id. → [saving & rename](../saving-and-rename.md), attachedNote.ts `landed`
- A delete outside the app closes a clean note ("Note deleted elsewhere") and writes nothing.
  An editor with unsaved edits stays on the note: the save that recreates the note at its id
  with the draft (the session's before the verdict, or the host's timer) says "Open note was
  deleted; keeping local draft", and the verdict then finds nothing changed. When that save
  fails or is held, the draft stays open with the same message, its next save recreating the
  note. A delete made in the app
  closes the note first; a request that reaches the ended attachment is answered `Deleted` and
  the page shows no note. → createExternalChangeCoordinator.ts `applyDisposition`,
  sidebarFolderMutations.ts, attachedNote.ts `acknowledged` and `Landed.recreated`,
  DesktopEditor.svelte, attachedNote.test.ts
- The editor's own saves and the merges they write, seen by the file watcher, change nothing:
  the draft, the file and the baseline already agree, or the save offers the merge again at a
  revision the page has moved past, which the page ignores. →
  crates/futo-notes-sync/src/open_note.rs `Leave`, attachedNote.ts `landed`
