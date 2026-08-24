# Implementation plan — Find in note (issue #26)

Implements the spec landed by MR !235: `docs/spec/editor.md` → "Find in note", plus
the Ctrl/Cmd+F and Ctrl/Cmd+G lines in `docs/spec/tabs.md`. Read the spec first;
this plan does not restate the behavior, it says where each rule lands in the
code and in what order.

Branch: `feat/find-in-note` (worktree `.claude/worktrees/feat-find-in-note`),
based on `docs/spec-find-in-note` so the spec is present while implementing.
Rebase onto `main` once !235 merges.

**Hand-off from cross-note search is descoped** (MR !235). `docs/spec/search.md`
and every result-open path stay untouched. Replace is out of scope. `find` is
not a formatting-toolbar item, so `packages/editor/src/toolbar.ts` and its
generated native specs are untouched and `just toolbar-spec` is never run.

---

## 1. The architectural call: a CodeMirror panel, not shell chrome

The find bar is a **CM6 top panel** (`showPanel` from `@codemirror/view`)
rendered by the shared editor, not a Svelte component in either host's chrome.

This is what makes "one implementation" fall out for free rather than being a
rule someone has to remember:

- `src/features/editor/MarkdownEditor.svelte` is mounted by **both** hosts —
  desktop through `src/app/components/NoteWorkspace.svelte:125`, and the
  native shells through `src/editor-embed/main.ts:51`, which loads the same
  component into `editor.html`. Anything inside the editor's own extension list
  is automatically on desktop, iOS, and Android with zero per-shell work
  (AGENTS §4, M6/M10).
- `MarkdownEditor.svelte` renders exactly one bare `<div>`, and `editor.html:117`
  documents that contract ("MarkdownEditor.svelte mounts a single wrapper `<div>`
  inside `#editor`"). A sibling bar element would change that DOM shape and the
  embed CSS that targets it. A panel lives _inside_ `.cm-editor`, so the shape
  is unchanged.
- A top panel is pinned to the top of the scroller by construction — which is
  the spec's placement rule — and CM6 already accounts for panel height when
  computing `scrollIntoView`. Stepping to a match therefore cannot scroll it
  underneath the bar. Hand-rolled chrome would have to reproduce that.
- Both shells already keep the editor viewport above the keyboard inset
  (Android via `imePadding()` on the editor `Column`,
  `NoteEditorScreen.kt:~710`), so the "keyboard never covers the bar" rule needs
  no new native layout code.

Follow the house pattern for editor-internal UI — pure state module + DOM
renderer, mirroring `editorUX/slashMenuState.ts` + `editorUX/slashMenuRenderer.ts`
and `editorUX/selectionToolbar.ts`. Plain DOM, not a mounted Svelte component:
that is what every existing in-editor surface does, and it keeps the logic
unit-testable without a component harness.

New files, all under `src/features/editor/find/`:

| File                 | Contents                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findState.ts`       | `StateField` (query, current match index, open flag), `StateEffect`s, and the commands `openFind`, `closeFind`, `stepFind(+1/-1)`, `setFindQuery`. Pure, no DOM. |
| `findMatches.ts`     | Match computation over the doc via `@codemirror/search` `SearchCursor`; count, current-index resolution, wrap arithmetic. Pure.                                  |
| `findDecorations.ts` | `ViewPlugin` painting all-match and current-match decorations over the **viewport range only**.                                                                  |
| `findPanel.ts`       | The `showPanel` renderer: query input, count readout, prev/next/close buttons, its keymap.                                                                       |
| `findExtension.ts`   | Assembles the above into one `Extension` for `createMarkdownEditorRuntime`.                                                                                      |
| `*.test.ts`          | Co-located vitest, per `codebase-organization.md`.                                                                                                               |

---

## 2. Sharp edges found in the code (read before writing anything)

These are the things that will bite. Each one is a real property of this
codebase, not a generic caution.

### 2.1 Nothing reveals hidden markdown while the query field has focus — CRITICAL

`live-preview/selectionReveal.ts:34` —

```ts
export function getCursorLinesForReveal(hasFocus, ranges, doc): Set<number> {
  if (!hasFocus) return new Set();
  ...
}
```

Every reveal path (`shouldRevealMarkdownSyntax`, `selectionTouchesRange`,
`shouldSkipBlockDecorations`) gates on the editor having DOM focus. The find
bar's query input takes focus away from `.cm-content`, so `view.hasFocus` goes
false and **no line reveals its source** — directly breaking the spec's "the
CURRENT match is always visible on screen" rule for any match inside hidden
syntax, which is the single most subtle behavior in the whole spec.

The hook already exists and currently has **no production caller**:
`freezeSelectionReveal(hasFocus, ranges)` / `clearSelectionRevealFreeze()` /
`setSuppressSelectionReveal(true)` in the same file, exercised only by
`liveMarkdownTransform.reveal.test.ts:61`. It was built for exactly this shape
of problem — UI outside the editor holding focus while the document should keep
rendering as though the caret were live.

Plan: while the find bar is open, freeze the reveal at the current match's range
and suppress the focus-derived reveal, refreshing the freeze on every step and
clearing it on close. Prove it with a test that asserts a match inside
`[label](url)` reveals its source with `view.hasFocus === false` — that test
should be written **first**, because it is the one that fails without this
mechanism and passes silently in a naive implementation that only ever tests
with the editor focused.

### 2.2 Android system Back needs to know the bar is open → BRIDGE_VERSION 8 → **stop and ask**

`NoteEditorScreen.kt:418` has a single `BackHandler {}`. The spec says Back with
the bar open dismisses the bar, not the screen. The shell cannot know: the bar
lives inside the WebView, and it can close from inside (the X button) without
the shell hearing about it. Tracking a shell-side flag set when the shell sends
`exec("find")` desynchronizes the first time the user taps X, and then one Back
press gets silently swallowed.

The correct fix is an additive outbound message (`findState`, carrying
open/closed) in `packages/editor/src/bridge.ts` `OUTBOUND_MESSAGE_TYPES:310`.
That is a `BRIDGE_VERSION` bump to **8**, and the version history at
`bridge.ts:20-55` shows the precedent exactly: v4, v5, and v6 are each one
additive outbound message with the note "a host that doesn't handle it just
drops the message".

**AGENTS §11.6 makes any `BRIDGE_VERSION` change stop-and-ask.** Do not write
this until it is approved. Both native hosts move together (M10) and
`just bridge-spec` must regenerate `apps/ios/Sources/Editor/GeneratedContracts/BridgeSpec.swift`
and its Kotlin sibling (M8), with `just bridge-spec-check` green.

Phase 4 is structured so everything else ships without this. If it is refused,
the fallback is Android-only: keep Back exiting the screen and record a
`> **Gap:**` in `editor.md` — never a shell-side guess at the bar's state.

### 2.3 `exec` ids are documented as toolbar-manifest ids

`bridge.ts:125` says "`commandId` is the id of an `exec` item in the toolbar
manifest", and `toolbar.ts:17-22` says the same from the other side. The spec
decided `find` is dispatched over `exec` but is **not** a manifest item, so both
doc comments need one sentence: `exec` takes a shared command id from
`TOOLBAR_EXEC`, of which the manifest's `exec` items are a subset.

This is a comment change, not a contract change — a new accepted id is
backward-compatible (an older host simply never sends it, and
`createFutoEditorApi.ts:151` already warns and ignores unknown ids). No version
bump for this part, separate from 2.2.

### 2.4 Find state clears on note switch — for free, but verify

`noteHistory.ts:57` restores via `EditorState.fromJSON(..., FIELDS)` where
`FIELDS` covers only the history field, and `openNote` swaps the whole state
through `swapEditorState`. A find `StateField` is therefore re-initialized to
closed whenever a note is opened or a desktop tab is switched back to — which is
exactly the spec's rule. Do not add teardown code for it; add a test that pins
the behavior so a later change to `FIELDS` cannot silently start restoring a
stale bar.

Watch `resetHistory()` (`MarkdownEditor.svelte:~190`): it also swaps state, and
the embed calls it on every `initialize`/`setContent` from the host — i.e. every
native note open. Same desired outcome, different trigger. Test both.

### 2.5 `@codemirror/search` is a new dependency — dedupe or the editor goes blank

Absent from `package.json` and from the lockfile. Add it to the **root**
`package.json` (the editor package has no runtime deps of its own), and pin it
the way its neighbours are pinned — `@codemirror/state` is `6.7.1` and
`@codemirror/view` is `6.43.6`, both exact, not caret.

M22: a duplicate `@codemirror/*` copy in the tree renders CM6 blank in a
WebView. After installing, run `pnpm why @codemirror/state` and confirm a single
version, then check the editor actually still renders on a device before
believing any green unit run.

### 2.6 The desktop accelerators are `window` listeners with no focus guard

`registerNotesShellShortcuts.ts` binds on `window` and none of the existing
accelerators guard against focus being in a text input. That is harmless for
Ctrl+P/N/T/W, but Ctrl+F is a key people expect inside _any_ field. Add the
guard for the new keys only — do not retrofit the existing ones in this branch
(unrelated behavior change).

The Home-tab no-op falls out of `EditorApi` being absent/inactive; assert it
rather than assuming.

---

## 3. Phases

Each phase is one commit, `type(scope): imperative summary`, and each is
independently reviewable. Phase 1 is the whole feature on desktop; 2–4 are
per-shell entry points.

### Phase 0 — dependency and skeleton

`build(editor): add @codemirror/search for find-in-note`

- Add `@codemirror/search` (exact pin) to root `package.json`; `pnpm install`.
- Verify the dedupe (2.5).
- No behavior yet.

**Verify:** `pnpm why @codemirror/state`, `just build`.

### Phase 1 — the shared find surface

`feat(editor): find in note`

1. `findMatches.ts` + tests: case-insensitive literal substring over the doc
   (`SearchCursor` with a normalized comparator), count, current-index, wrap.
   Cover the spec's own examples — `cat` finds `concatenate`; `"Aug "` with the
   trailing space matches only `Aug` + space; zero matches.
2. `findState.ts` + tests: field, effects, `openFind` / `closeFind` /
   `stepFind` / `setFindQuery`. Open seeds from the selection when non-empty,
   else the previous query. `stepFind` on a closed bar is a no-op; on zero
   matches it is a no-op.
3. `findDecorations.ts`: all-match + current-match decorations, computed over
   `view.visibleRanges` only. M5 — this runs on document change, so it must not
   scan the whole document per keystroke in a large note; scan the viewport for
   painting and keep the total count on a debounced pass (the spec explicitly
   permits the count to lag an edit by a frame).
4. **The reveal fix (2.1)** and its focus-less test.
5. `findPanel.ts`: the bar via `showPanel`. Query field, `"3 of 17"` /
   `"No matches"`, prev/next/close. Panel-local keymap: Enter → next,
   Shift-Enter → previous, Escape → close and return focus to the editor with
   the selection on the current match.
6. `findExtension.ts`, wired into `createMarkdownEditorRuntime.ts`'s extension
   array next to `slashMenu` / `wikilinkAutocomplete`.
7. `find: openFind` added to `TOOLBAR_EXEC` in
   `src/features/editor/markdownToolbar.ts:25`, plus the two doc-comment
   corrections from 2.3.

**Verify:** `just test-unit`, `just test-editor`, `just check`, plus a
Playwright spec (`tests/find-in-note.spec.ts`) covering open → type → count →
step → wrap → Escape, and the reveal-while-unfocused case.

### Phase 2 — desktop invocation

`feat(desktop): bind Ctrl/Cmd+F and Ctrl/Cmd+G to find in note`

- Extend `NotesShellShortcutDeps` with `openFind` and `stepFind(direction)`;
  bind `f`, `g`, and `Shift+g` with the focus guard from 2.6.
- Extend the frozen `EditorApi` in `NoteWorkspace.svelte:17` with `openFind`
  and `stepFind`, exported from `MarkdownEditor.svelte`, bound through
  `NotesShell.svelte:391`'s existing `bind:editorApi={editor}`.
- Ctrl/Cmd+F with the bar open refocuses and selects the query; on a Home tab it
  does nothing; Ctrl/Cmd+G with the bar closed does nothing.

**Verify:** `src/AGENTS.md` chain (§7.1) + the Playwright spec extended to the
accelerators; drive the real desktop app per `/verify` — never OS-level input
(M24, `scripts/qa-target.mjs` only).

### Phase 3 — iOS invocation

`feat(ios): add Find in note to the editor overflow menu`

- One `Button`/`Label("Find in note", systemImage: "magnifyingglass")` in the
  existing `Menu` at `NoteEditorView.swift:244`, above the `Divider()`.
- Add `func exec(_ commandId: String)` to `EditorHost`
  (`EditorWebView.swift`) beside `blur()`/`setNotes()`, reusing the
  `jsLiteral` + `evaluateJavaScript` form already at line 737. No find logic in
  Swift (M6).

**Verify:** `apps/ios/AGENTS.md` chain (§7.6) — `just build-rust-ios` first
(M9), then `just test-ios-native` and `just ios-native` on a claimed pooled
simulator (`just qa-claim ios`). Confirm on-device that the bar sits above the
keyboard and that the formatting toolbar does not stack with it.

### Phase 4 — Android invocation (+ the Back rule, gated)

`feat(android): add Find in note to the editor overflow menu`

- One `DropdownMenuItem("Find in note")` in the `DropdownMenu` at
  `NoteEditorScreen.kt:679`, calling the existing `exec(...)`
  (`EditorWebView.kt:634`).
- **Gated on 2.2's approval:** the `findState` outbound message, `BRIDGE_VERSION`
  → 8 with a history entry in the same style as v4–v6, `just bridge-spec`
  regeneration for both hosts, and the `BackHandler` at `NoteEditorScreen.kt:418`
  consuming Back while the bar is open. If not approved, ship the menu item
  alone and record the Back divergence as a `> **Gap:**`.

**Verify:** `apps/android/AGENTS.md` chain (§7.7) — `just build-rust-android`
(M9), `just test-android-native`, `just android-native` on a claimed pooled
emulator; `just bridge-spec-check` if the bridge moved.

### Phase 5 — spec closure

`docs(spec): record find-in-note as implemented`

- Remove the proposal `> **Gap:**` from `editor.md` "Find in note" and the
  sibling in `tabs.md` only for behavior that actually shipped; keep a gap for
  anything a phase left divergent (Android Back, or the interactive-table reveal
  if it does not land).
- Delete the closure probe added in !235 from `scripts/spec-gaps.mjs` — it fires
  on `@codemirror/search` entering `package.json`, which Phase 0 does, so it will
  go off on the first run otherwise.
- `just spec-gaps` + `just spec-gaps-check`, per `/spec-sync`.

---

## 4. Open question carried from !235

**Widget-replaced regions** (question 4, still open). The spec requires stepping
to a match inside an interactive table's source to reveal that source the way
placing the caret there does. `table/tableEditorWidget.ts` replaces the range
with a widget and moves the selection itself (`:35`,
`this.view.dispatch({ selection: ... })`), so a find step landing inside a table
may be re-captured by the widget rather than revealing source.

Resolve this during Phase 1 with a real test against the table widget before
writing the panel — the answer may be "the table widget wins and a match inside
a table is reached by exiting the widget first", which would be a spec
amendment, not a bug. Do not guess; if the behavior cannot be made to match the
spec cheaply, record the divergence as a gap and raise it rather than quietly
loosening the spec line (M19, AGENTS §11.5).

---

## 5. Approval gates

Per AGENTS §11, stop and ask before:

1. Bumping `BRIDGE_VERSION` to 8 / adding the `findState` outbound message (2.2).
2. Amending the spec's intent if the interactive-table answer forces it (§4) —
   closing a gap is fine, changing specified behavior is not.

Everything else is reversible in-repo work: proceed.

---

## 6. Pre-merge

`just check` at minimum; `just prepush` before pushing, since this touches the
editor hot path, both native shells, and (conditionally) the bridge. Report the
commands and their real results (M18, M11) — a partially-run chain is reported
as partially run.
