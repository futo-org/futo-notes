## Find in note

Find-in-note locates text inside the OPEN note — match highlighting plus
next/previous stepping — as opposed to cross-note search ([search.md](../search.md)),
which retrieves whole notes from the vault index. The two surfaces are
independent: this one is opened by its own affordance and seeded only from the
editor's own selection or the previous query, and cross-note search is
unchanged by it.

- **One engine, thin platform bars.** All find behavior — matching, highlight
  decorations, current-match tracking, next/previous stepping with wrap, and
  count arithmetic and count wording — lives in the shared
  editor bundle. Desktop renders that engine's full-width bottom panel.
  iOS and Android render native SwiftUI/Compose bars because the web panel is
  not native-quality mobile chrome; those bars only forward
  query/open/step/close actions and render the bundle's
  `{query, current, total, label}` report verbatim. They never scan text,
  compute a count, or decide a wrap. Matching is a run scan over the ProseMirror
  document: every maximal run of ADJACENT text, so a query spanning a mark
  boundary (`**bo**ld`) matches while one spanning a paragraph boundary cannot.
  Highlighting is a ProseMirror `DecorationSet` covering the whole document — it
  maps through a transaction instead of being rebuilt, so a keystroke costs a map
  and never a scan. → src/features/editor/milkdown/find/
- Native chrome drives the engine through the bridge-v8 `openFind`,
  `setFindQuery`, `stepFind`, and `closeFind` methods and receives `findMatches`
  reports. Find is NOT an `exec` command or a button in the scrollable formatting
  toolbar: that toolbar stays formatting-only, so the toolbar manifest
  (packages/editor/src/toolbar.ts) and its generated native specs are untouched.
  The overflow menu is the only mobile entry point.
- _(desktop)_ Ctrl/Cmd+F opens the find bar for the active tab's note, query
  field autofocused — pre-filled with the editor's selection when one exists,
  otherwise with the previous query, selected either way. Ctrl/Cmd+F with the
  bar already open refocuses and selects the query. A Home tab has no
  document, so it does nothing there. The accelerator is recorded in tabs.md's
  shortcut list. → registerNotesShellShortcuts.ts
- _(iOS/Android)_ "Find in note" is an entry in the editor screen's existing
  overflow menu (Android's ⋮ DropdownMenu, iOS's ellipsis-circle Menu), so it
  is reachable while reading with the keyboard down. The item shows the native
  bar and calls the shared engine's `openFind` bridge method. →
  NoteEditorScreen.kt actions, NoteEditorView.swift toolbar Menu
- The desktop bar spans the bottom of the editor, like Firefox's find bar. On
  iOS and Android it spans the bottom of the editor viewport, immediately above
  the virtual keyboard while the query field is focused. The bar shows: the
  query field, a live match count ("3 of 17"; "0" at zero), next and previous
  buttons, and a completion control. Android uses a single flat, divided bar in
  the platform browser style: query, count, previous, next, then close; its count
  turns red and its step buttons disable at zero matches; the desktop bar does
  the same. iOS uses a leading
  checkmark to close, a search capsule with its count inline, and a separate
  previous/next capsule; desktop keeps its compact full-width panel.
- Matching is **case-insensitive literal substring** — no case toggle, no
  whole-word, no regex in v1 (the simplest behavior meeting #26; toggles can
  join the same bar later without breaking anything here). Literal means find
  has none of cross-note search's retrieval semantics: no fuzzy, no
  prefix/mid-typing rule, no all-words preference — `cat` finds `concatenate`,
  and `Aug ` (trailing space) finds only `Aug` followed by a space.
- **Matching runs over the editor's document text.** Results never depend on
  cursor position or on what is scrolled into view, and every match is a real
  range the selection (and any future replace) operates on.
- A line break inside a paragraph reads as a space, so a match runs across it
  exactly as across a soft wrap: `man yes` finds `hey man` / `yes` on two lines.
  A match never runs across two blocks. → find/findMatches.ts `docTextSegments`,
  tests/editor-embed-milkdown-find.spec.ts

- Find searches the note **body** only. The title is the filename — a native
  field on the native shells, not part of the document text — and titles are
  cross-note search's job (search.md indexes them).
- Every match is highlighted; the current match is visually distinct from the
  rest and is scrolled into view when stepped to.
- A find bar that overlays the editor viewport keeps the scrolled-to current
  match clear of the strip it covers — so "scrolled into view" means visibly on
  screen, never under the bar. One engine rule, two ways of learning the
  height: _(iOS)_ the bar overlays the WebView's bottom edge and declares its
  rendered height to the engine; _(desktop)_ the bar is docked over the bottom
  of the editor's own scrolling pane, so the engine measures that panel itself
  and the shell declares nothing; _(Android)_ the bar is a layout sibling above
  the WebView, so the viewport is never covered and no inset is declared.
  → setFindOverlayInset, findPlugin.ts `revealMatch`, NoteEditorView.swift,
  NoteEditorScreen.kt
- Revealing a match inside hidden markdown moves it after the scroll: the
  source appears, the line reflows, and the match can land back under the bar.
  The engine re-measures the current match once that relayout settles and
  re-reveals it, so a match ends up visible wherever the reflow put it.
  → find/findPlugin.ts `revealMatch`
- _(desktop)_ the selection toolbar does not show for find's own selections:
  it stays down while the bar is open, and for the selection find leaves
  behind after Escape; the next selection the user makes shows it normally.
  → find/findPlugin.ts `findSuppressesSelectionToolbar`,
  selectionToolbar/target.ts
- **Stepping to the next occurrence** is the core interaction, and it is
  reachable three ways while the bar is open: the next/previous buttons in the
  bar (the mobile path — they work with the keyboard down), Enter / Shift+Enter
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
- Editing while the bar is open keeps it open: matches, highlights, and the
  count recompute against the new text. Apart from the two stepping
  accelerators above, find claims no keys in the note body — Enter,
  Shift+Enter and Escape belong to find only while the query field is focused,
  so typing in the body behaves exactly as it does without find.
  Recomputation never adds to keystroke latency (M5): a keystroke only MAPS the
  matches and decorations it already has through its own transaction, the rescan
  runs one animation frame later, and the count may therefore lag an edit by a
  frame.
- Find state is per open note view: the query and current match survive while
  the note stays on screen — including device rotation on the native shells
  (Android saves the bar's query/visibility and the retained WebView keeps the
  engine state; the OS may drop the soft keyboard) — and closing the bar,
  switching desktop tabs, or leaving the note clears active highlights. A
  closed bar may remember its previous query for the next open on the same note;
  no find state crosses a note boundary or persists in `.app-config.json`.
- _(desktop)_ Escape closes the bar and returns focus to the editor with the
  selection left on the current match.
- _(Android)_ System Back with the bar open dismisses the bar, not the screen:
  that Back is consumed by find. → NoteEditorScreen.kt `findBackAction`

- _(Android)_ Closing the bar takes the soft keyboard down with it whenever the
  bar's own query field owned the keyboard, so the next Back leaves the note.
  The field is a native `EditText`, and Android leaves the IME shown when the
  view serving it is removed: a keyboard left bound to the departed field
  swallows the next Back instead (measured before the fix: `mInputShown=true`
  with the bare `AndroidComposeView` served, and leaving the note took a second
  Back). Dismissal does NOT hand focus back to the editor body — the WebView
  stays unfocused until the user taps into it. When the body owns the keyboard
  instead (the user tapped into the note while the bar was open) it stays up,
  and standard Android applies: a Back drops the keyboard before a Back leaves
  the note. → NoteEditorScreen.kt `dismissFind`
- _(iOS)_ the X closes the bar; the editor's exit chrome (back chevron / edge
  swipe) exits the note as usual, taking the bar with the screen.
- _(iOS/Android)_ Closing the find bar clears every match highlight and restores
  the editor selection and viewport from before find opened.
- _(iOS/Android)_ the soft keyboard can never cover the bar: it is docked
  immediately above the keyboard by the shell's keyboard-safe layout.
  While the native find query field is focused the WebView is unfocused, so the
  formatting toolbar does not show — that toolbar is editor-body-focus chrome
  (## Markdown toolbar), and the two bars never stack.
- **Hand-off from cross-note search is out of scope.** Opening a note from a
  search result (desktop popup, Android SearchScreen, iOS inline list search)
  opens the note exactly as it does today: at its normal position, with no
  find bar and no seeded query. Seeding find from a retrieval query would need
  the query carried to the note-open path on all three platforms — on the
  native shells that is a hostBoot/bridge change (stop-and-ask, root AGENTS.md
  §11.6) — and retrieval semantics are broader than literal find (fuzzy,
  prefix, all-words), so a retrieval hit does not imply a literal occurrence to
  land on. Nothing here forecloses it; the find surface is self-contained and a
  seed can be added later.
- Replace is **out of scope** for this surface: #26 asks for finding, the
  engineering default is the simplest implementation that meets the current
  requirement, and replacing inside markup the live preview hides invites
  invisible markdown corruption without dedicated UX. The shared
  `@codemirror/search` core supports layering replace onto the same bar later
  if it is ever asked for.
