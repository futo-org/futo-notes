## 10. Follow-ups / backlog (recorded, not scheduled)

Parity gaps and other divergences from CodeMirror that the maintainer decided to ship as recorded
`docs/spec/editor.md` Gaps rather than fix pre-merge (2026-09-21 disposition). Each line names the
Gap it closes so a later pass can grep for it.

- **Table editing parity.** Add a column-alignment picker (left/center/right) and a whole-table
  delete affordance. → closes the `docs/spec/editor.md` "Tables" Gap on
  `src/features/editor/milkdown/table/tableCommands.ts`.
- **Bare URL autolink while typing.** Port an input rule equivalent to the deleted CodeMirror
  `links/autolinks.ts` so a typed URL linkifies immediately instead of only after save/reopen. →
  closes the `docs/spec/editor.md` "External links" Gap.
- **Per-note undo history.** `prosemirror-history` has no stash/restore API; closing this needs a
  per-note history snapshot it will accept back on re-open, mirroring the CodeMirror engine's
  `noteHistory.ts`. → closes the `docs/spec/editor.md` "Saving & rename" undo Gap on
  `MilkdownEditor.svelte` `resetHistory`/`openNote`.
- **Native body inset.** Give `.ProseMirror` a padding rule that reads the `--futo-cm-pad-inline`
  CSS variable the shells already send, instead of the fixed 54px/18px gutters. → closes the
  `docs/spec/editor.md` "Native host boot" Gap on `MilkdownEditor.svelte` `.ProseMirror` padding.
- **Giant single-paragraph notes — progress indicator.** Show a spinner/loading affordance on both
  native shells while a synchronous whole-document parse is in flight: Android's
  `EditorSession.isInteractionLocked` already flags the window, iOS needs the equivalent signal
  wired to its own exit-capture path.
- **Giant single-paragraph notes — title gating.** Gate the title swap on a body-applied signal from
  the editor rather than on the note id alone, so the next note's title never shows over the
  previous note's stale body during a slow parse.
- **Giant single-paragraph notes — non-blocking parse.** Confirmed multi-day work, not a quick patch:
  chunk on soft line breaks INSIDE a paragraph (append inline content into the same paragraph, so
  block structure and bytes never change), because the 41 s desktop WebKitGTK cost (§5's 2026-09-21
  note) is the parse/dispatch of one `<p>` with tens of thousands of inline children, not the chunk
  planner (`planMarkdownChunks` itself declines `no-boundary` in ~41 ms).
- **WebKitGTK has no `requestIdleCallback`.** `scheduleIdleSlice` (progressiveLoad.ts) already falls
  back to `setTimeout(0)` when it's absent (Safari/WKWebView), but desktop Linux hits the same
  fallback path too — every desktop progressive-load idle slice runs on `setTimeout(0)`, never the
  real browser idle scheduler.
- **Front matter aria-label.** `packages/editor/src/milkdown-compat/frontmatter.ts`'s "Front matter"
  aria-label is a literal, not yet routed through the language catalog (AGENTS.md §5, every
  user-visible string is a catalog entry).
- **Slash-menu filtering matches only the English label.** Each row in `slash/items.ts` carries a
  hardcoded English `label` for query matching and a separate `labelPath` (`editor.slashMenu.commands.*`)
  that `menu.ts` renders through `localizedText` for display — deliberate today (the comment at
  `slash/items.ts:29-31` explains the split), but once a translation lands for a row, typing the
  WORD THE USER SEES will not match it: matching still runs against the English string nobody is
  looking at. Closing this needs query matching to consider the localized label too, not just the
  English one.
- **iOS swift-format debt.** `apps/ios/Sources/Editor/EditorWebView.swift` carries 11 pre-existing
  `swift-format` lint errors (`just lint-swift`); not introduced by this branch, not cleaned up by
  it either.
- ~~Android's anonymous late `change` could reach the next note (#194).~~ Superseded by bridge v9 in [editor-owns-the-document.md](../editor-owns-the-document.md): both hosts route by note id and generation. Native device verification is recorded in that living plan.
- **`dividerCaret.ts` runs two whole-document walks per doc-changing transaction.**
  `newlyCreatedDivider` (`dividerCaret.ts:87-118`) calls `hrPositions()` — a `doc.descendants` walk —
  once each on `oldState.doc` and `newState.doc`, inside `appendTransaction`, so it re-walks the
  WHOLE document on every user edit, not just ones that touch an `hr`. Within the measured perf
  budget at tested note sizes today, but it is an unsanctioned per-keystroke whole-document walk
  (AGENTS.md M5) with no bound on note size. Bound it with the changed-range approach
  `blockDecorations.ts`'s `changedRanges()` (`blockDecorations.ts:37`) already uses, so the walk
  scales with the edit, not the note.
- **`EditorSession`'s exit coroutine has no exception isolation (pre-existing).**
  `NoteEditorScreen.kt` hands it `rememberCoroutineScope()` — a plain, non-supervisor `Job` — so an
  uncaught non-cancellation exception from an `EditorExitEffects` method still crashes the app;
  needs a `CoroutineExceptionHandler` or a supervisor scope.
- **Android `insertImageWithinDeadline` timeout (6s) with a BUSY rather than dead renderer:** the
  queued `FutoEditor.insertImage(filename)` still runs after the deadline, so the note gains an
  `![](image-…)` reference to a file `deleteImageOnFailure` has already removed (a dangling
  reference instead of an orphaned blob). Fix: a generation on the insert call so the renderer
  refuses a late insert; separate follow-up to the document mailbox migration.
