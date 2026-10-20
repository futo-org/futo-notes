## 11. Traps the agent will meet

- **`FindInNoteStateTest` source scans** grep for method names (§5.6). Rename nothing it names.
- **The Android `onReady` fires immediately on attach when `isReady` is already true**
  (`EditorWebView.kt:831-856`): the mailbox must be seeded by `documentLoaded`, not by attach,
  or a never-edited note is "behind" forever (no `latest`). Treat "no `latest` and no
  `editedThrough`" as current-with-nothing-to-save, and log it.
- **iOS `attach` rebinds closures** (`EditorWebView.swift:971-996`). Replace the single
  `onChange` closure with a `[noteId: handler]` map; `detach(token)` removes only its own id.
- **Two views on the same note id** during an iOS push/pop of the same note (open A, link to
  A): the mailbox is per id, both views read the same `latest`; the register already coalesces
  by id with highest token winning (`NotesStore.swift:448-467`). Fine; add a test.
- **`settledFlush` must still advance the baseline** before the next write of the same id, or
  a background flush followed by a fast `change` parks a conflict copy. Do not weaken it.
- **`blur()` inside the old `captureScript`** was doing double duty (drop the keyboard, then
  read). The self-flush on blur keeps the first half useful; the shells still call `blur()` in
  `prepare()`.
- **Do not add a per-keystroke post.** `edited` is a transition. If a test needs per-keystroke
  generations, read them through the test hook, not the bridge.
- **`just check` currently has a known red** on this machine: the enormous-paragraph open
  budget (~2.05 s vs 2.0 s). Pre-existing; report it, do not touch the budget (M15).
- **Catalog strings** (root AGENTS.md §5): the one new toast key goes in `languages/en.json`.
- **Worktree**: this plan lives in `~/Developer/futo-notes-step1-editor-ownership`
  (`just wt new step1-editor-ownership`, slot ports already assigned). Build and run from it
  through `just`, never from the primary checkout.
