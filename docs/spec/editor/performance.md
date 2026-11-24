## Performance

- Typing is sacred (M5): per-keystroke editor work must not scale with document
  size. The budget is a **16 ms p95 synchronous keystroke at every note size**,
  enforced by running the typing stories against the real native Android app on
  the low-end reference phone; the desktop editor's own keystroke budget is in
  [desktop/editing.md](desktop/editing.md). →
  apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTypingBenchmarkTest.kt,
  `just test-android-perf`

- Opening a note is budgeted at **under 1 s at the sizes real notes reach**, and
  above them cost must scale LINEARLY — no cliff. →
  apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTypingBenchmarkTest.kt

- _(desktop)_ The window can be closed while the page's JS thread is stalled (a
  giant note opening, an 8 s task, a multi-megabyte paste). The close is
  JS-mediated (`startNativeShell.ts` `onCloseRequested`), so Rust arms a deadline
  on the first close request: if the app is still alive 5 s later (the JS
  handler's own 3 s flush race plus 2 s margin) AND the page reports nothing
  unsaved, Rust saves the edits the editor host already holds, waits for any
  in-flight vault write (the process-wide `vault_mutation_guard`, at most 5 s
  more) and exits without the JS thread. A page with an unsaved edit is not cut
  at the deadline: it tells Rust on every clean/dirty transition, at once on
  `beforeinput`, `paste`, `cut` and `drop` (before the stalling work begins),
  and on its next 200 ms poll for edits that raise no input event (Undo, Tab,
  Ctrl+K); Rust then waits for the JS handler. That wait ends early when the page
  that set the flag is gone (WebKitGTK's `web-process-terminated`, or a new page
  load; WKWebView and WebView2 are not hooked) and is capped at 60 s, because a
  window must always be closable: a longer stall loses an edit still inside the
  page, with one log line; edits the host already holds are saved. The JS handler
  does not abandon a write still running after its 3 s race (up to 15 s), so a
  slow disk leaves no `.sf-tmp-*` file. →
  apps/tauri/src-tauri/src/close_deadline.rs, src/app/closeDeadlineDirty.ts,
  src/app/startNativeShell.ts, tests/desktop-close-deadline.mjs

- The FIRST focus of an opened note — the tap that starts typing — is budgeted
  at **under 1 s at real-note sizes** on the reference phone.
- Per-keystroke work does not scale with the number of links on screen times the
  vault. Rendering a wikilink needs the whole note-id list twice — once to resolve
  the target, once for the shortest unique display suffix — so both go through one
  index the engine holds, never per link; `[[` completion shares it. The index is
  rebuilt whole only when the note list changes. → crates/futo-notes-wikilinks/src/index.rs,
  crates/futo-notes-editor/src/engine/commands/wikilinks/note_ids.rs `update_note_ids`
- The native Android text-first editor's open, streaming and command performance: [Android text-first editor](performance/android-text-first.md)
