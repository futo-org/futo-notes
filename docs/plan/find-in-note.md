# Implementation plan — Find in note (issue #26)

Implements the spec proposed in MR !235 (`docs/spec/editor.md` → "Find in note",
plus the Ctrl/Cmd+F and Ctrl/Cmd+G lines in `docs/spec/tabs.md`), **amended by
the maintainer's 2026-08-25 decision: the find bar UI is NATIVE on iOS and
Android** (SwiftUI / Compose), not the web panel inside the WebView — the web
bar looked bad on mobile. The shared editor bundle still owns every behavior;
the native bars are dumb chrome driven over the bridge. Phase 0 amends the
!235 spec text to match before any code lands (M19 — spec first).

Branch: `feat/find-in-note` (worktree `.claude/worktrees/feat-find-in-note`),
based on `docs/spec-find-in-note`. Rebase onto `main` once !235 merges.

## 0. Where the worktree actually is (2026-08-25)

An **uncommitted web-panel implementation already exists in this worktree** —
it is the version whose mobile bar looked bad and prompted the native pivot.
Inventory:

- `src/features/editor/find/` is complete: engine (`findState.ts`,
  `findMatches.ts`, `findDecorations.ts`), the reveal fix (freeze calls live in
  `findExtension.ts`'s lifecycle), the web bar (`findPanel.ts`), and tests.
- Desktop wiring is done: shortcuts, `EditorApi`, `MarkdownEditor.svelte`
  exports, `noteHistory` interplay.
- The native shells each carry a ~5-line menu item dispatching `exec("find")`,
  `find` was added to `TOOLBAR_EXEC`, and `bridge.ts`'s `exec` doc comment was
  loosened to cover non-toolbar ids.
- `@codemirror/search 6.7.1` (exact pin) is in `package.json` + lockfile.
- `docs/spec/editor.md`/`tabs.md`/`GAPS.md` and the `scripts/spec-gaps.mjs`
  probe were already reworked toward "implemented".

**The pivot keeps the engine and desktop wholesale.** What it replaces is
delivery on mobile: `findPanel` must be excluded under `nativeShell`
(`findExtension.ts:81` currently includes it unconditionally), the
`exec("find")` route dies (remove the `TOOLBAR_EXEC` entry and both menu
`onClick`s; the bridge doc-comment loosening reverts with it), and the native
bars + v8 contract are new work. Line numbers cited below are from the
committed base and may drift a few lines against the working tree.

**Still descoped** (unchanged from !235): hand-off from cross-note search,
replace, and a formatting-toolbar button. `docs/spec/search.md`,
`packages/editor/src/toolbar.ts`, and the generated toolbar specs stay
untouched.

---

## 1. Ownership split: shared engine, three thin bars

The M6 line does not move: **matching, current-match tracking, stepping with
wrap, highlight decorations, and the reveal of hidden markdown all live in the
shared editor bundle.** What changes is only who renders the four-control bar:

| Platform | Bar UI                                                                                                                | Drives the engine via                     |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Desktop  | Full-width CM6 bottom panel (`showPanel`) inside the editor — desktop is entirely web, with no native shell option | direct calls into `findState.ts` commands |
| iOS      | SwiftUI bar in `NoteEditorView.swift`, below the `EditorWebView` and immediately above the keyboard                  | bridge (`FutoEditorApi` find methods)     |
| Android  | Compose bar in `NoteEditorScreen.kt`, below the WebView and inside the keyboard-inset `Column`                       | bridge (same methods)                     |

The native bars contain **zero find logic**: no matching, no count arithmetic,
no wrap decisions. They hold exactly (a) the query string the user is typing,
(b) the last `{current, total}` the engine reported, and (c) visibility. Every
keystroke in the query field is forwarded to the engine; every count shown is
one the engine sent back. A native bar that computes anything is an M6
violation.

Shared-side layout, all under `src/features/editor/find/`:

| File                 | Contents                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findState.ts`       | `StateField` (active flag, query, current index, native return selection/scroll snapshot), `StateEffect`s, commands `openFind` / `closeFind` / `setFindQuery` / `stepFind(±1)`.                         |
| `findMatches.ts`     | Match computation via `@codemirror/search` `SearchCursor`; count, current-index resolution, wrap arithmetic. Pure.                                                                                          |
| `findDecorations.ts` | `ViewPlugin` painting all-match + current-match decorations over `view.visibleRanges` only.                                                                                                                 |
| `findPanel.ts`       | Desktop-only `showPanel` bar (house pattern: plain-DOM renderer like `editorUX/slashMenuRenderer.ts`). Excluded when `nativeShell` — the flag already exists in `createMarkdownEditorRuntime.ts`'s options. |
| `findExtension.ts`   | Assembles the extension; `nativeShell` drops the panel, keeps everything else.                                                                                                                              |
| `*.test.ts`          | Co-located vitest.                                                                                                                                                                                          |

### What going native bought (verified in the code, not assumed)

- **iOS toolbar stacking — dissolved.** The formatting toolbar is the
  keyboard's `inputAccessoryView`, swizzled onto the private `WKContentView`
  and keyed on WebView focus (`EditorWebView.swift:616`:
  `futo_overrideInputAccessoryView(focused ? toolbarAccessory : nil)`). A web
  query field inside the WebView keeps `focused == true`, so the formatting
  toolbar would have stayed docked while typing a query — a spec violation the
  web-panel plan would have needed a new bridge signal to fix. A native
  `TextField` becomes first responder, the WKContentView resigns, `.focus`
  fires false, the accessory nils itself. Free.
- **Android toolbar stacking — dissolved.** `NoteEditorScreen.kt:839` shows the
  formatting toolbar only while `host.editorFocused && WindowInsets.isImeVisible`.
  Native find field focus → `editorFocused` false → toolbar hides. Free.
- **Android system Back — dissolved.** The bar is now shell state, so the
  `BackHandler` at `NoteEditorScreen.kt:418` can consume Back while it is
  visible with no bridge round-trip and no desync risk. The web-panel plan
  needed an outbound `findState` message for this alone.
- **Keyboard docking.** Both native bars occupy the bottom slot in layouts the
  shells already keep above the keyboard inset.

### What it costs

- **A bidirectional bridge contract** (§2.2) — larger than the web panel's
  would have been, and chatty: query updates flow in per keystroke, counts flow
  out per recompute. Acceptable: both are tiny payloads on an existing
  `evaluateJavaScript`/`postMessage` path that already carries full document
  text on every edit.
- **Two bar implementations to keep visually honest.** Mitigated by the bars
  being genuinely dumb (see above) and by the spec pinning the strings. To keep
  the count wording from drifting, the outbound message carries the
  **preformatted display label** ("3 of 17" / "0") alongside the raw
  `{current, total}` — one string formatter, in the bundle. Check whether
  `scripts/drift-check.mjs` flags the two bars; if it does, register the pair
  with the rationale "dumb renderers of a bridge-owned engine, strings supplied
  by the bundle".

---

## 2. Sharp edges (read before writing anything)

### 2.1 Nothing reveals hidden markdown while the WebView is unfocused — CRITICAL, now central

`live-preview/selectionReveal.ts:34` gates every reveal path on editor DOM
focus (`if (!hasFocus) return new Set()`). With a native bar this is no longer
an edge case — **the WebView is unfocused for the entire find interaction**,
so without a fix, no match inside hidden syntax (`[label](url)`, emphasis
markers, wikilink brackets) ever reveals its source, breaking the spec's
"current match is always visible" rule — its most subtle line.

The hook exists and has no production caller: `freezeSelectionReveal(hasFocus,
ranges)` / `clearSelectionRevealFreeze()` / `setSuppressSelectionReveal(true)`
in the same file, exercised only by `liveMarkdownTransform.reveal.test.ts:61`.
While find is active, freeze the reveal at the current match's range, refresh
on every step/query change, clear on `closeFind`. Write the failing test
**first**: a match inside `[label](url)` must reveal with
`view.hasFocus === false`. A naive implementation passes every test written
with the editor focused and ships broken.

### 2.2 The bridge contract — BRIDGE_VERSION 8

The maintainer's native-bar decision entails the bridge change, answering the
AGENTS §11.6 stop-and-ask (2026-08-25). The shape:

**Inbound** (new `FutoEditorApi` methods, style-matched to
`setContent`/`setTheme`):

- `openFind()` — mark find active, freeze-reveal machinery arms; the engine
  immediately posts a match report for the current (possibly remembered) query.
- `setFindQuery(query: string)` — recompute; post a report.
- `stepFind(delta: number)` — move current match, scroll it into view, reveal;
  post a report. No-op when inactive or zero matches.
- `closeFind()` — clear highlights and restore reveal; the native bridge path
  also restores the selection and viewport captured before find opened, while
  the desktop panel keeps its specified current-match selection.

**Outbound** (one new message in `OUTBOUND_MESSAGE_TYPES`,
`packages/editor/src/bridge.ts:310`):

- `findMatches` — `{ current, total, label }` where `label` is the preformatted
  count string (§1). Posted on every recompute while active, throttled with the
  count-may-lag-a-frame allowance the spec grants (M5).

`BRIDGE_VERSION` 7 → 8 with a history entry in the v4–v6 style
(`bridge.ts:20-55`): additive — a v7 host never calls the methods and drops the
message. Both hosts move in the same commit (M10); `just bridge-spec`
regenerates `BridgeSpec.swift`/`.kt` (M8) and both hosts' `BridgeCoverageTest`s
must handle the new outbound type; `just bridge-spec-check` green.

Note `exec('find')` is **dead** in this design: desktop opens its panel
in-process, native shells call `openFind()` directly. The working tree's
`TOOLBAR_EXEC` `find` entry and the `exec("find")` menu dispatches are removed
in Phase 1. The !235 spec text saying find is "dispatched over `exec`" is
amended in Phase 0.

### 2.3 Native bar state must die with the note, not just the screen

The engine side clears for free: `noteHistory.ts:57` restores only the history
field and `openNote`/`resetHistory` swap whole states, so the find
`StateField` re-initializes to inactive on every note open — pin with a test.
But the **native bar's own visibility is shell state** and must be closed by
the shell on note switch/screen exit, or the bar shows over a note the engine
isn't finding in. iOS: the bar is per-`NoteEditorView`, dies with the screen.
Android: same screen-scoped state; also decide rotation — `rememberSaveable`
for query + visibility satisfies the spec's rotation-survival line, and the
retained WebView keeps the engine state consistent. On reattach after process
death, don't restore the bar (the engine forgot too).

### 2.4 `@codemirror/search` is new — dedupe or the editor goes blank

Absent from `package.json` and the lockfile. Add to the **root** `package.json`
with an exact pin like its neighbours (`@codemirror/state` `6.7.1`,
`@codemirror/view` `6.43.6`). M22: a duplicate `@codemirror/*` renders CM6
blank in a WebView — after install, `pnpm why @codemirror/state` must show one
version, and Phase 1's device check is not optional.

### 2.5 Desktop accelerators are `window` listeners with no focus guard

`registerNotesShellShortcuts.ts` binds on `window`; none of the existing keys
guard against focus in a text input. Harmless for Ctrl+P/N/T/W; not for
Ctrl+F/G. Guard the new keys only — do not retrofit the old ones here.
Home-tab no-op falls out of the editor being absent; assert it.

---

## 3. Phases

One commit each, `type(scope): imperative summary`, independently reviewable.

### Phase 0 — amend the spec (in MR !235, still open)

`docs(spec): find-in-note bars are native on mobile`

Rewrite the affected `editor.md` lines: the shared bundle owns matching,
stepping, highlights, count strings, and reveal; the bar is the editor's own
full-width bottom panel on desktop and keyboard-docked native shell chrome on
iOS/Android, driven by the find methods of the bridge (v8, listed as part of
the proposal); invocation is no longer `exec`. Keep every behavioral line
(literal matching, source-text matching, body-only, wrap, rotation, Back,
never-stack) — only the rendering owner changes. The working tree already
reworked `editor.md`/`tabs.md`/`GAPS.md` and the spec-gaps probe toward the
web-panel version — rewrite those edits for the native wording rather than
layering on top. `just spec-gaps` + `spec-gaps-check`; push to !235.

### Phase 1 — land the engine + desktop, strip the mobile web bar

`feat(editor): find in note engine and desktop panel`

Mostly triage of what already exists in the working tree, not new writing:

1. **Keep:** the whole engine, the desktop panel, desktop keys, `EditorApi` and
   `MarkdownEditor.svelte` wiring, tests, the `@codemirror/search` pin (run the
   2.4 dedupe check before trusting it).
2. **Change:** exclude `findPanel` under `nativeShell` in `findExtension.ts:81`
   — the flag already reaches `createMarkdownEditorRuntime.ts`.
3. **Revert:** the `find` entry in `TOOLBAR_EXEC`, both native shells' menu
   `onClick: exec("find")` diffs (the menu items themselves return in Phases
   3/4 wired to `openFind()`), and the `bridge.ts` `exec` doc-comment
   loosening.
4. **Audit before adopting:** the existing tests against the spec's own cases
   (`cat` finds `concatenate`; `"Aug "` trailing-space; zero matches), the
   focus-less reveal test (2.1 — it must assert `view.hasFocus === false`),
   M5 viewport-only painting in `findDecorations.ts`, and the note-switch
   clearing test (2.3, engine half). Inherited code is reviewed, not presumed.

**Verify:** `just test-unit`, `just test-editor`, `just check`, new
`tests/find-in-note.spec.ts` (open → type → count → step → wrap → Escape;
reveal-while-unfocused; Home-tab no-op), real desktop app per `/verify`
(M24 — `scripts/qa-target.mjs` only).

### Phase 2 — bridge v8

`feat(editor): find-in-note bridge contract (BRIDGE_VERSION 8)`

The contract from 2.2: four inbound methods in `bridge.ts` +
`createFutoEditorApi.ts`, `findMatches` outbound, version history entry, bump,
`just bridge-spec` regeneration for both hosts, both `BridgeCoverageTest`s.
No native UI yet — this commit is the contract and its generated artifacts.

**Verify:** `packages/editor` tests, `just bridge-spec-check`, `just check`.

### Phase 3 — iOS native bar

`feat(ios): native find-in-note bar`

- SwiftUI bar (query `TextField`, count label, prev/next/close) in
  `NoteEditorView.swift`, shown by a "Find in note" item
  (`magnifyingglass`) in the existing `Menu` at `:244`, above the `Divider()`.
- `EditorHost` (`EditorWebView.swift`) gains thin wrappers calling the v8
  methods, same `jsLiteral` + `evaluateJavaScript` form as `:737`, and routes
  `findMatches` in `userContentController` to the bar's state.
- Bar dies with the screen (2.3); count text is the bundle's `label`, verbatim.

**Verify:** §7.6 chain — `just build-rust-ios` (M9), `just test-ios-native`,
`just ios-native` on a claimed pooled simulator; on-device: formatting
accessory absent while the find field is focused, match stepping reveals
hidden syntax, keyboard never covers the bar.

### Phase 4 — Android native bar

`feat(android): native find-in-note bar`

- Compose bar below the WebView in `NoteEditorScreen.kt`'s keyboard-inset editor `Column`;
  "Find in note" `DropdownMenuItem` in the `DropdownMenu` at `:679`; thin
  `EditorWebView.kt` wrappers beside `exec` (`:634`); `findMatches` routed to
  bar state.
- `BackHandler` (`:418`) consumes Back while the bar is visible — plain shell
  state now, no bridge involvement.
- `rememberSaveable` query/visibility for rotation (2.3).

**Verify:** §7.7 chain — `just build-rust-android` (M9),
`just test-android-native`, `just android-native` on a claimed pooled emulator;
on-device: formatting toolbar hidden while the find field is focused, Back
dismisses bar then screen.

### Phase 5 — spec closure

`docs(spec): record find-in-note as implemented`

Remove the proposal `> **Gap:**`s (editor.md + tabs.md) for what shipped; keep
a gap for any divergence (e.g. the interactive-table answer, §4). Delete !235's
closure probe from `scripts/spec-gaps.mjs` — it fires on `@codemirror/search`
entering `package.json`, which Phase 1 does. `just spec-gaps` +
`spec-gaps-check` per `/spec-sync`.

---

## 4. Open question carried from !235

**Widget-replaced regions** (question 4). `table/tableEditorWidget.ts:35`
dispatches its own selection when the widget takes focus, so a find step
landing inside an interactive table's source may be re-captured by the widget
instead of revealing source. Resolve in Phase 1 with a real test before the
panel exists; if matching the spec is not cheap, record the divergence as a
gap and raise it — never quietly loosen the spec line (M19, AGENTS §11.5).

---

## 5. Approval gates

1. ~~BRIDGE_VERSION 8~~ — **decided 2026-08-25**: the maintainer chose native
   bars, which entails the bridge change; the exact contract shape (2.2) lands
   for review in Phase 2's MR rather than as a fresh stop-and-ask.
2. Amending spec intent if the interactive-table answer forces it (§4) — still
   stop-and-ask.

Everything else is reversible in-repo work: proceed.

---

## 6. Pre-merge

`just check` minimum; `just prepush` before pushing — this touches the editor
hot path, the bridge, and both native shells. Report commands and real results
(M18, M11); a partially-run chain is reported as partially run.
