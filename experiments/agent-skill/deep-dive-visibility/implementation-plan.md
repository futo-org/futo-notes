## 5. Implementation plan, ordered and test-first

Each step is small, lands on its own, and starts with a failing test (AGENTS.md 7.9).

0. **Spike, 1–2 h, on claimed devices only.**
   - iOS 26 simulator: confirm the presented-VC chain types for the Settings sheet, the rename
     `.alert`, the delete `fullScreenCover` and `ShareLink`, and the first-responder capture for
     the title field.
   - Android API 34/36 emulator: confirm `WindowManagerGlobal.mViews` and
     `ViewRootForTest.semanticsOwner` show `NewFolderDialog`, `FolderPickerSheet` and a
     `DropdownMenu` with `IsDialog`/`IsPopup`.
   - This decides D2/D3 or the S1 fallback, before any code.
1. **Honest rows** (`agentElements.ts`): `focused` only on the active element, `collapsed`,
   `checked`, `aria-disabled`, `value`.
   - jsdom tests first in `agentInspector.test.ts`: a labelled input shows its value; a checkbox is
     `checked`; the focused input's ancestors are not `focused`.
   - `covered` is tested in Playwright, because jsdom has no layout (`elementsFromPoint` is
     guarded).
2. **`uiState()` into `state` and the snapshot**, together with `editor.find` and `clipboard`.
   Regression tests that fail today:
   - `SetFindQuery ""` diff names the find change;
   - `ToggleLanguageOptions` twice gives `+listbox` then `-listbox`;
   - `Copy` gives a clipboard diff;
   - `CloseSettings` gives `-dialog`.
3. **Markup completeness + static gate**: roles on SearchPopup (`dialog` + `aria-modal` + label), the
   image menu (`menu`), the toast (`status`), the find panel (`search`), and `aria-busy` on
   Settings' loading row. Then `check-agent-visibility` (a, b, d) with red proofs. Run `/spec-sync`
   if `docs/spec/` states a11y behaviour for these surfaces.
4. **Evidence ring**: `ui`/`notice`/`error`/`effect`/`app-menu` entries; receipts list their window
   and `since last`.
   - Tests: a toast raised by an async verb is recorded; a thrown `window` error is recorded; the
     `MoveNote` receipt carries its effect (a regression, 115/115 empty today).
   - Perf: the `state` p50 must stay under 10 ms in the page. Assert that the observer skips
     `.cm-content`.
5. **C1 OS-dialog chokepoint**. Test with a mocked plugin: `pendingNativeDialog` shows as
   `os-dialog` while awaiting, and clears after.
6. **D5 settle** (with sibling (a)/audit C3): regression tests for Settings' late row and
   `OpenNote`'s document, with the 300 ms cap measured on the Jev desktop sweep.
7. **CLI** (with audit C1/C5): render `ui` lines, `unseen`, the `state` diff for native verbs.
   These are Rust unit tests beside `diffs_render_as_change_lines_or_no_change`.
8. **iOS D2 + S1 + sampler**: Swift Testing of the mapper, then live verification on a claimed
   simulator with `just agent state` and screenshots (`sim-screenshot`) as the oracle.
9. **Android D3 + `AppToast` + S1**: JVM test of the mapper, an instrumented check on a claimed
   emulator, and gate rule (c).
10. **Runtime sweep spec** into `release:gate.needs`. Jev's observation keeps the rows' flags and `ui`,
    and `computed.overlay` is deleted (payload trimming is sibling (a)'s).
11. **Docs**: commands.md (the `state` keys, receipts, `unseen`, removing `settingsOpen`/`searchOpen`),
    SKILL.md "The loop" (`state` answers overlays and focus), the design record's
    "native chrome out of scope" paragraph. Then `just check-agent-docs` and `just check-agent-first`.

### Risks

- **Perf** (M5): a hit-test per row and a document-wide MutationObserver. Both are debug only; the
  observer is coalesced to one per frame and skips `.cm-content`. Measure `state`/`elements` before
  and after (page <10 ms today, audit §1).
- **ARIA correctness**: roles must be true for screen readers, not bolted on for the agent.
  `aria-modal` on Search changes what VoiceOver announces, which is the point, but it needs a
  VoiceOver spot-check.
- **Test engines**: jsdom cannot check `covered`/`top`, and Playwright Chromium is not WKWebView
  (M22) for the top layer and `:popover-open`. The rule is re-proved once in `just tauri-dev`.
- **Private native APIs**: `WindowManagerGlobal`, and UIKit hosting-controller class names that
  change between iOS versions. Classify by behaviour (`isKind(of: UIAlertController)`,
  `modalPresentationStyle`, semantics properties) and use class names only as a label fallback.
  All of it stays debug-only, because a release build compiles the stubs.
- **Declaration ceiling**: S1 is per file, like check-agent-verbs. A view with two in-view surfaces
  and one declared passes; review holds that line.
- **Focus when the window is not key**: `activeElement` persists while `:focus` does not.
  Reporting `window.focused` stops agents from misreading this.
- **Samplers miss flashes** under 250 ms on native; the page's observer does not have this problem.
- **Removing `settingsOpen`/`searchOpen`**: harnesses and Jev rubrics read them (grep
  `tool-eval`, `jev-drive.mjs`). Keep both until the sweep passes, then delete both in one commit.
- **Found along the way** (report, not in scope): the Settings dialog does not move focus into
  itself. NoteActionsMenu and the image menu are not `dismissable`, so Escape may not close them
  (verify). `CopyCurrentNotePath` writes the person's OS clipboard when an agent runs it, which is
  against the skill's "never the OS one".
