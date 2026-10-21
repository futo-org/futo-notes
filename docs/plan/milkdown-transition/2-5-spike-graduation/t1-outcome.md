### T1 outcome (#98, done)

Branch `feat/milkdown-editor` (the spike was already on current main, so the rebase was a rename).
What the review changed:

- **Undo could destroy a note (fixed).** `resetHistory()` was a no-op, and the host calls it on
  every `initialize`/`setContent` — i.e. every note open. The first Ctrl-Z after opening a note
  un-applied the load and left the document EMPTY, and after a note switch undo replayed the
  previous note's steps into the current file. It now rebuilds the ProseMirror state around the live
  doc (prosemirror-history has no clear command), preserving doc and caret.
- **One hardened block move for both drag paths.** The iOS long-press path validated the source
  range at drop time and moved the NODE; the ⠿-handle touch fallback still trusted positions
  captured at pointerdown and inserted a re-fitted SLICE, which is exactly the "my heading stopped
  being a heading" failure the iOS path was hardened against (M17, fixed 1 of N). Both now commit
  through `blockMove.ts`.
- **`markActive` said one thing and did another.** Its comment claimed a mark must cover every
  character of a range; it used `rangeHasMark`, which is "occurs anywhere". "Anywhere" is correct —
  it matches what `toggleMark` will do to that selection — so the comment was fixed, not the code.
- **The ⠿ gutter handle was dead for one commit, and a test caught it.** The first fix for the undo
  bug rebuilt the EditorState; `EditorState.create` copies the plugin array, so `view.updateState`
  destroyed every plugin view, and @milkdown/plugin-block's BlockProvider — which parents its handle
  outside the ProseMirror DOM and only appends on its first `update()` — never put it back.
  `resetHistory` now sets the history plugin's state through the `historyKey` meta its own undo/redo
  commands use, touching nothing else.
- **Decomposition.** `MilkdownEditor.svelte` 1,152 -> 838 lines (570 script + 268 style, which
  stays with the component). Extracted into `src/features/editor/milkdown/`: `blockMove.ts`,
  `handleBlockDrag.ts` (the ⠿ touch fallback), `formatState.ts`, `caretContext.ts`,
  `toolbarExec.ts`, `blockDragMode.ts`, alongside the moved `blockDragGeometry.ts` and
  `mobileBlockDnd.ts`.
- **`mobileBlockDnd.ts` was reviewed but deliberately NOT decomposed** (669 lines, now the feature's
  largest file). Its two separable parts are already out — geometry into `blockDragGeometry.ts`, the
  commit into `blockMove.ts`. What is left is one long-press gesture state machine that has to be
  read as a single sequence (arm -> suppress selection -> lift -> drag -> release), plus the
  device-earned constraints doc comment and the stylesheet for the ghost card, which only make sense
  next to the code they explain. Splitting it would scatter one gesture across files without making
  any part of it independently understandable.
- **Tests where there were none.** `tests/editor-embed-milkdown.spec.ts` (28 cases) drives the real
  `editor.html` bundle: the load-echo guard over markdown Milkdown would normalize, the undo
  boundary, the change contract, `formatState`, and the long-press block drag through real CDP touch
  input. Unit tests cover `blockMove` and `formatState` (18 cases).
- **The CodeMirror contract suite now pins `?cm`.** Making Milkdown the default engine had silently
  turned `editor-embed-bridge.spec.ts` red (33 of 50), most of it CM6-specific DOM and
  markdown-source assertions. It loads `CM6_EDITOR_URL` and dies with CM6 at the swap.

A second review pass (standards axis) then fixed: a CI `changes:` list that did not name the new
spec files, so an MR touching only them dropped `test:e2e:editor-embed` to manual + allow_failure
(M11 class); a platform branch inside a component (`isIOS` in `MilkdownEditor.svelte`, now
`blockDragMode.ts` — src/AGENTS.md forbids the former); two comments citing rules that do not exist;
and the duplication the two drag paths had re-grown around auto-scroll and target resolution.

Recorded, not fixed here:

- `formatState` has no Android consumer — deferred to **#104** by this ticket's acceptance criteria,
  and recorded in `bridge.ts` and `BridgeCoverageTest.kt`. `haptic` is iOS-only by construction:
  Android mounts the gutter-handle drag and never emits it. **Superseded 2026-09-01 — Android now
  mounts the long-press drag and receives `haptic`; see §4.**
- Toolbar parity gaps found by the suite, all **#104** (closed there — see the T7 outcome below):
  `link` with an empty selection does nothing, `indent` needs a preceding sibling item, and list
  markers serialize as `*` rather than `-`.
- **The empty-note load echo was luck, not contract** (fixed as part of the review round). The
  guard could not fire for a note that loaded empty — `liveMarkdown` started as `''`, so
  `setContent('')` looked like content already held and skipped the path that records a baseline. It
  happened to be harmless because Milkdown serializes an empty document to `''`; a serializer change
  would have turned opening a brand-new note into a rewrite. `liveMarkdown` now starts null, and
  three spec cases cover empty and whitespace-only notes.

- **Change notification is debounced 200 ms with no maxWait** (`@milkdown/plugin-listener`), so
  sustained typing can defer the host's `change` — and therefore its autosave — indefinitely. Exit
  and background paths read `getContent()` directly, so this is a crash-window question, not a
  lost-work-on-exit one. Owned by **#105** (save semantics).
  **This is now an observed device failure, not just a risk on paper**: `just test-ios-stories`
  ("sustained typing keeps one note and every keystroke") FAILS on this branch — 30 s after the
  typing stops the note on disk still holds its original bytes. Reproduced on the iOS 26.5
  simulator 2026-08-28 at both `5bb4c5c8` (this ticket's base) and the T7 commit on top of it, with
  an identical signature, so it is the branch's behavior and not any one ticket's regression. It is
  the first red the Milkdown branch has in that suite; #105 has to make it green again before the
  swap.
