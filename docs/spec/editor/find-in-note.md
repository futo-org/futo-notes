## Find in note

Find follows [the portable core contract](portable-core/find.md): [desktop find](desktop/find.md)
specifies the desktop bar and [mobile find](mobile/find.md) the native one.

Find-in-note locates text inside the OPEN note — match highlighting plus
next/previous stepping — as opposed to cross-note search ([search.md](../search.md)),
which retrieves whole notes from the vault index. The two surfaces are
independent: this one is opened by its own affordance and seeded only from the
editor's own selection or the previous query, and cross-note search is
unchanged by it.

- *(desktop)* Ctrl/Cmd+F, stepping (Enter, Shift+Enter, Ctrl/Cmd+G, Ctrl/Cmd+Shift+G), the bottom bar, highlights, and Escape are specified in [desktop find](desktop/find.md). The accelerators are recorded in tabs.md's shortcut list. → src/features/editor/desktop/findInNote.ts, tests/desktop-editor-find-stories.mjs
- *(desktop)* Matching is **case-insensitive literal text** — no case toggle, no whole-word, no regex, no replace — with none of cross-note search's retrieval semantics: no fuzzy, no prefix/mid-typing rule, no all-words preference. `cat` finds `concatenate`, and `Aug ` (trailing space) finds only `Aug` followed by a space. Every Greek sigma (`Σ`, `σ`, final `ς`) is one letter, so `ΟΔΟΣ` finds `ΟΔΟΣΑ`; a character whose lowercase is longer (`İ`) matches only itself. → crates/futo-notes-editor/src/engine/commands/find.rs
- *(desktop)* Find searches the note **body** only. The title is the filename, separate from the document text, and titles are cross-note search's job (search.md indexes them). A retrieval result opens at the note's ordinary position without a seeded find query.
- *(desktop)* Find state is per open note view: closing the bar, switching tabs or leaving clears active highlights; a closed bar may remember its previous query for that note. No find state crosses a note boundary or persists in `.app-config.json`.

- *(mobile)* The overflow menu opens a native find bar above the keyboard, with query, localized count, previous, next and close controls. Native bars forward to the Rust session's shared find core; they do not scan Markdown or infer matches. Match painting, stepping, rescanning and composition behavior follow [mobile find](mobile/find.md) and [portable find](portable-core/find.md). → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstFind.kt
- *(mobile)* Counts use “3 of 17” and “0” at zero. Android uses a flat divided bar (query, count, previous, next, close), with a red zero count and disabled zero-match stepping; iOS uses a leading completion checkmark, a search capsule with inline count and a separate previous/next capsule. → ui/NoteEditorFindBar.kt, apps/ios/Sources/Notes/Editor/FindInNoteBar.swift
- *(mobile)* Find searches the body, not the filename title. Every match is highlighted, the current match is distinct, stepping wraps, and zero matches disables stepping. A selected match is revealed inside the native viewport, clear of the find bar. Cross-note search never seeds this bar, and Replace remains out of scope. → [mobile find](mobile/find.md)
- *(mobile)* The native query field owns the keyboard while focused, so the body formatting accessory stays hidden and the bars never stack. The bar remains usable with the keyboard down. Closing clears highlights and restores the selection and viewport from before find opened. → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstFind.kt
- *(mobile)* Query and current-match state belong to the open note view and survive rotation; leaving the note clears active highlights, and no state crosses note identities or persists in `.app-config.json`.
- *(Android)* System Back with find open closes find before leaving the note. Closing hides the IME when its query field owns it and leaves the body unfocused; if the body or a table cell owns the keyboard, closing find preserves that input. Query Enter/Search steps once and Shift+Enter steps backward. → textfirst/TextFirstEditorScreen.kt, textfirst/TextFirstFind.kt, ui/NoteEditorFindBar.kt
- *(iOS)* The find bar's completion control closes find; system Back and edge swipe leave the note and take the bar with it. → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/ios/Sources/Editor/TextFirst/TextFirstNoteScreen.swift
