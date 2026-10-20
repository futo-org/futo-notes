## Wikilinks — navigation & integrity

- `[[`…`]]` is a wikilink when it holds at least one character that is neither a
  line ending nor the start of `]]`; the whole inner text is the target. A `!`
  immediately in front of one (`![[Note]]`, Obsidian's embed syntax) is **plain
  text followed by a wikilink** — the `!` is claimed as text so micromark's
  image label cannot swallow the `![` and leave the link escaped. **Everywhere
  else a `!` is ordinary text and begins nothing**: at the end of a line, at the
  end of the file with no trailing newline, inside a table cell (`| a | no!! |`),
  before a space, or before another `!`. The tokenizer decides this BEFORE it
  opens its token, so no path can strand one open — a stranded `wikilink` token
  stops the enclosing paragraph or table cell from closing, which threw on parse
  and opened the WHOLE note blank on every shell (issue #112, fixed
  2026-09-03). → src/features/editor/milkdown/wikilink/syntax.ts,
  src/features/editor/milkdown/wikilink/syntax.test.ts,
  tests/editor-embed-milkdown-wikilinks-autocomplete.spec.ts
- Clicking/tapping a wikilink navigates to the target note (desktop:
  Cmd/Ctrl+click opens it in a new tab; middle-click opens it in a background
  tab). Rapid clicks on separate links each navigate. → NotesShell.svelte
  onopenlink, milkdown/linkTaps.ts `handleLinkClick`
- A wikilink displays the **shortest unique path suffix** (`[[Projects/Roadmap]]`
  renders as "Roadmap" while unambiguous). The native shells feed the vault
  note list into the shared editor WebView over the bridge (`setNotes`), so
  the same resolver runs there (verified Android native + iOS simulator
  2026-06-09). → wikilinks.ts, packages/editor bridge v2,
  EditorWebView.kt / EditorWebView.swift
- Typing `[[` opens autocomplete over all note ids; selecting inserts the full
  path, **closes the `]]`, and drops the caret AFTER the link** (`[[Title]]|`)
  so typing continues past the link, not inside it (a bare change dispatch left
  the caret stranded after `[[`). Works on desktop and both native shells (same
  embed; verified on emulator + simulator 2026-06-09; caret-after-`]]` verified
  emulator + simulator 2026-07-08). The completion inserts the wikilink NODE and
  puts the selection just past it. →
  src/features/editor/milkdown/wikilink/autocomplete.ts,
  src/features/editor/wikilinkSuggestions.ts
- A wikilink whose target does not resolve is still decorated, styled **broken**
  (`cm-md-link cm-md-wikilink cm-md-wikilink-broken`) — not undecorated, and
  **visually distinct from a resolved link** (muted/dimmed styling so a dead
  link is identifiable before you tap it). The
  resolver (`resolveWikilink`) treats an **ambiguous** target (a bare filename
  matching more than one note) exactly like an absent one: both return `null` and
  render broken. Tapping a broken wikilink opens an empty editor bound to the
  wikilink's target text as the title; the note file is **created on the first
  edit/save**, not eagerly at navigation time — a **deferred** create-on-missing
  path (2026-07-11 decision). The earlier "eager" wording was already false on
  shipped desktop: `read_note` returns `""` for a missing file (never throws), so
  the create-on-missing catch in `loadNote` was dead and the empty note simply
  opened via the normal read path; the file appeared only once the user edited.
  → src/features/editor/milkdown/wikilink/display.ts, wikilinks.ts
  `resolveWikilink`, createNoteLoader.ts, editor-embed/main.ts
- On the native shells, tapping a resolved wikilink navigates: the embed
  resolves the raw target against the pushed note list and posts `openNote`
  to the host, which **PUSHES a new editor onto the nav stack** — so **Back
  returns to the note you came from, not straight to the list** (a browser-like
  history of visited notes). A broken link posts nothing; a self-link (a
  wikilink to the note you are already on) is a no-op. Taps navigate via a
  dedicated `touchend` path — WebKit cancels the synthetic `click` after the
  handler's prevented `mousedown`, so a click-only handler dead-ends on iOS
  while Chromium double-fires; the touchend path covers both. A tap on a
  navigable link follows it on the **first** tap even when the editor is
  unfocused: a `touchend` that lands on a resolved wikilink or external link is
  handled by the link path rather than left to place the caret (a _broken_
  wikilink still
  focuses, so it can be edited). The editor consumes a tap on a NAVIGABLE link
  (`consumesTap`) and deliberately leaves a broken one to ProseMirror.
  Scrolling, dragging, cancelling, or holding through the block long-press
  threshold does not follow the touched link; a completed short tap follows it
  once, even if the WebView also emits a synthetic click.
  Android already follows on the first tap (verified emulator 2026-07-08). Each pushed iOS
  editor needs an explicit `.id(noteId)` identity or SwiftUI would share one
  view's @State across the chain. Because the editor WebView is a single shared
  instance, iOS re-adopts it into whichever editor is visible on push/Back
  (`EditorContainerView.onEnterWindow`), and off-screen editors never drive it;
  Android composes only the top of the stack, so one note binds the WebView at
  a time by construction. Verified emulator + simulator 2026-07-08 (A → wikilink
  → B → Back returns to A with A's content intact and the editor still
  interactive; Back again returns to the list). →
  src/features/editor/milkdown/linkTaps.ts `handleTouchEnd`
  `activateLink`, AppNavigation.kt `AppNavigator.openNote` (push),
  NoteEditorView.swift `openLinkedNote` + EditorWebView.swift `Coordinator.adopt`,
  tests/editor-embed-milkdown-wikilinks.spec.ts
- Native Back and resolved-wikilink navigation wait for every admitted editor
  mutation, await the latest tagged document, and persist-or-park a dirty
  snapshot through the Rust draft workflow before changing the navigation
  stack. A concurrent peer edit therefore keeps both versions instead of being
  overwritten. A failed commit keeps the same editor visible and dirty and
  surfaces the save failure. This includes a valid pending title whose Rust
  rename fails and, on iOS, an admitted image insertion: navigation waits for
  the insertion's editor transaction and deferred bridge callback before
  committing. Android applies this to toolbar Back, system Back, and wikilinks;
  iOS applies it to wikilinks only. →
  `EditorNavigationCommit.kt`, `NoteEditorScreen.kt`,
  `EditorHost.awaitCurrent`, `EditorCompletionQueue`,
  `NoteEditorView.requestNavigation`
- [iOS] Back is the system button, so Back and the edge swipe pop the editor
  FIRST and the same drain-and-commit runs after the pop, under a draft
  register entry that stays claimed until the write is durable (a failed
  commit is retried by the lifecycle flush, never lost). Nothing the user
  waits on between the tap and the list is a bridge round trip or a disk
  write; what remains is the pop animation and the keyboard going down.
  Hiding the system button to veto the exit would also disable the swipe
  (docs/learnings/ios-swipe-back-over-webview.md). Measured on the iOS 26.5
  simulator 2026-10-08: first list frame 50 ms after the tap (83 ms with the
  keyboard up), pop done by ~550 ms, the commit after it, for 1k and 10k
  blocks alike: docs/perf/mobile-close-ios.md. →
  `NoteEditorView.finishLeave`, `EditorBackAffordanceTests.swift`,
  `scripts/perf/ios-close-bench.mjs`
- **Renaming or moving a note rewrites every wikilink that points at it,
  across all notes** — including folder moves (`[[Markdown demo]]` →
  `[[Archive/Markdown demo]]`) and **self-referencing links inside the renamed
  note's own body** (a note linking to itself must not be left with a silently
  broken link after its own rename). → wikilinks.ts rewrite rules,
  notes.svelte.ts `rewriteWikilinksForRename`
- The relink rules also live in the shared Rust crate
  (futo-notes-model `wikilinks::{resolve_wikilink, shortest_unique_suffix,
rewrite_wikilinks}` + `relink_note_references`), conformance-locked
  bit-for-bit against wikilinks.ts (tests/conformance/wikilinks-*.json). The
  native shells call the single `NoteStore.rename` or `NoteStore.moveNote`
  workflow, which moves the note and rewrites backlinks vault-wide under the
  store's workflow lock (verified on emulator + simulator 2026-06-09:
  bare-leaf and full-path links in other notes rewrote on disk).
  `[[target|alias]]` links are not rewritten — the TS rules treat the whole
  inner text as the target, and the Rust port pins that behavior. →
  futo-notes-model wikilinks.rs, futo-notes-store `LocalNoteStore::rename`,
  futo-notes-ffi `NoteStore::{rename,move_note}`
