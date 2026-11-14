## Find in note

This section describes the shared Milkdown editor. Native text-first find follows
[the portable core contract](portable-core/find.md) and [its mobile surface](mobile/find.md).

Find-in-note locates text inside the OPEN note — match highlighting plus
next/previous stepping — as opposed to cross-note search ([search.md](../search.md)),
which retrieves whole notes from the vault index. The two surfaces are
independent: this one is opened by its own affordance and seeded only from the
editor's own selection or the previous query, and cross-note search is
unchanged by it.

- *(desktop)* **Desktop Milkdown find.** Matching, highlight decorations, current-match tracking, next/previous stepping with wrap, and count wording live in the editor bundle. Matching scans maximal adjacent text runs in the ProseMirror document, so a query can cross a formatting boundary but not a paragraph boundary. Decorations map through input transactions rather than scanning on every keystroke. → src/features/editor/milkdown/find/
- _(desktop)_ Ctrl/Cmd+F opens the find bar for the active tab's note, query
  field autofocused — pre-filled with the editor's selection when one exists,
  otherwise with the previous query, selected either way. Ctrl/Cmd+F with the
  bar already open refocuses and selects the query. A Home tab has no
  document, so it does nothing there. The accelerator is recorded in tabs.md's
  shortcut list. → registerNotesShellShortcuts.ts
- *(desktop)* The bar spans the bottom of the editor, with query, live count, previous/next and close controls. Zero matches turns the count red and disables stepping. → src/features/editor/milkdown/find/
- *(desktop)* Matching is **case-insensitive literal substring** — no case toggle, no
  whole-word, no regex in v1 (the simplest behavior meeting #26; toggles can
  join the same bar later without breaking anything here). Literal means find
  has none of cross-note search's retrieval semantics: no fuzzy, no
  prefix/mid-typing rule, no all-words preference — `cat` finds `concatenate`,
  and `Aug ` (trailing space) finds only `Aug` followed by a space.
- *(desktop)* Case-insensitive means one letter matches in either case wherever it sits in
  a word: every Greek sigma (`Σ`, `σ`, final `ς`) is one letter, so `ΟΔΟΣ` finds
  the start of `ΟΔΟΣΑ` and `οδος` finds `ΟΔΟΣΑ` too. Folding never moves a match
  off the text it covers; a character whose lowercase is longer (`İ`) matches
  only itself. → src/features/editor/foldCase.ts,
  tests/editor-embed-milkdown-find.spec.ts
- *(desktop)* **Matching runs over the editor's document text.** Results never depend on
  cursor position or on what is scrolled into view, and every match is a real
  range the selection (and any future replace) operates on.
- *(desktop)* A line break inside a paragraph reads as a space, so a match runs across it
  exactly as across a soft wrap: `man yes` finds `hey man` / `yes` on two lines.
  A match never runs across two blocks. → find/findMatches.ts `docTextSegments`,
  tests/editor-embed-milkdown-find.spec.ts

- *(desktop)* Find searches the note **body** only. The title is the filename, separate from the document text, and titles are
  cross-note search's job (search.md indexes them).
- *(desktop)* Every match is highlighted; the current match is visually distinct from the
  rest and is scrolled into view when stepped to.
- *(desktop)* The bar is docked over the bottom of the editor's scrolling pane; the engine measures it so a revealed match remains visible above the covered strip. → findPlugin.ts `revealMatch`
- *(desktop)* Revealing a match inside hidden markdown moves it after the scroll: the
  source appears, the line reflows, and the match can land back under the bar.
  The engine re-measures the current match once that relayout settles and
  re-reveals it, so a match ends up visible wherever the reflow put it.
  → find/findPlugin.ts `revealMatch`
- _(desktop)_ the selection toolbar does not show for find's own selections:
  it stays down while the bar is open, and for the selection find leaves
  behind after Escape; the next selection the user makes shows it normally.
  → find/findPlugin.ts `findSuppressesSelectionToolbar`,
  selectionToolbar/target.ts
- *(desktop)* **Stepping to the next occurrence** is the core interaction, and it is
  reachable three ways while the bar is open: the next/previous buttons in the
  bar, Enter / Shift+Enter
  while the query field is focused, and _(desktop)_ Ctrl/Cmd+G /
  Ctrl/Cmd+Shift+G, which step next/previous no matter where focus sits **while
  the bar is open** — so after clicking into the editor body you can keep
  jumping through occurrences and typing at the one you wanted. (Escape closes
  the bar, and a closed bar makes both accelerators no-ops; see below.) Each step moves the selection
  to that match, makes it the current match, and scrolls it into view.
  Stepping wraps past either end (the count shows the wrapped position; there
  is no separate wrap indicator), and with zero matches every step is a no-op.
  Ctrl/Cmd+G with the bar closed does nothing — it never reopens find. Both G
  accelerators are recorded in tabs.md's shortcut list. →
  registerNotesShellShortcuts.ts
- *(desktop)* Editing while the bar is open keeps it open: matches, highlights, and the
  count recompute against the new text. Apart from the two stepping
  accelerators above, find claims no keys in the note body — Enter,
  Shift+Enter and Escape belong to find only while the query field is focused,
  so typing in the body behaves exactly as it does without find.
  Recomputation never adds to keystroke latency (M5): a keystroke only MAPS the
  matches and decorations it already has through its own transaction, the rescan
  runs one animation frame later, and the count may therefore lag an edit by a
  frame.
- *(desktop)* Find state is per open note view: query and current match survive while the note stays open. Closing the bar, switching tabs or leaving clears active highlights; a closed bar may remember its previous query for that note. No find state crosses a note boundary or persists in `.app-config.json`.
- _(desktop)_ Escape closes the bar and returns focus to the editor with the
  selection left on the current match.
- *(desktop)* **Hand-off from cross-note search is out of scope.** A retrieval result opens at the note's ordinary position without a seeded find query; retrieval semantics (fuzzy, prefix, all-words) do not imply a literal match. Find remains self-contained.
- *(desktop)* Replace is out of scope; this surface offers finding without regex or replacement controls.

- *(mobile)* The overflow menu opens a native find bar above the keyboard, with query, localized count, previous, next and close controls. Native bars forward to the Rust session's shared find core; they do not scan Markdown or infer matches. Match painting, stepping, rescanning and composition behavior follow [mobile find](mobile/find.md) and [portable find](portable-core/find.md). → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstFind.kt
- *(mobile)* Counts use “3 of 17” and “0” at zero. Android uses a flat divided bar (query, count, previous, next, close), with a red zero count and disabled zero-match stepping; iOS uses a leading completion checkmark, a search capsule with inline count and a separate previous/next capsule. → ui/NoteEditorFindBar.kt, apps/ios/Sources/Notes/Editor/FindInNoteBar.swift
- *(mobile)* Find searches the body, not the filename title. Every match is highlighted, the current match is distinct, stepping wraps, and zero matches disables stepping. A selected match is revealed inside the native viewport, clear of the find bar. Cross-note search never seeds this bar, and Replace remains out of scope. → [mobile find](mobile/find.md)
- *(mobile)* The native query field owns the keyboard while focused, so the body formatting accessory stays hidden and the bars never stack. The bar remains usable with the keyboard down. Closing clears highlights and restores the selection and viewport from before find opened. → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstFind.kt
- *(mobile)* Query and current-match state belong to the open note view and survive rotation; leaving the note clears active highlights, and no state crosses note identities or persists in `.app-config.json`.
- *(Android)* System Back with find open closes find before leaving the note. Closing hides the IME when its query field owns it and leaves the body unfocused; if the body or a table cell owns the keyboard, closing find preserves that input. Query Enter/Search steps once and Shift+Enter steps backward. → textfirst/TextFirstEditorScreen.kt, textfirst/TextFirstFind.kt, ui/NoteEditorFindBar.kt
- *(iOS)* The find bar's completion control closes find; system Back and edge swipe leave the note and take the bar with it. → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift
