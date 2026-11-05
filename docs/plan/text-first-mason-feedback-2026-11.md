# Text-first Android editor — Mason's feedback round (2026-11)

Scope: the Android text-first editor on `android-text-first` (MR !564). It is dev-build only;
release Android still ships the WebView editor. Every fix lands on this branch (decision 8A).
Delete this file in the commit that finishes the last item (archive rule).

## Implementation checkpoint

The implementation and emulator measurements below are complete. Physical Pixel checks remain
blocked: the phone is secure-locked and its installed `com.futo.notes.dev` rejects this build's
different signing certificate. The Pixel's app was neither removed nor cleared, and no signing key was accessed.
Using its matching dev key requires the approval in AGENTS.md §11.1; unlocking is also needed.

| Items | Current evidence |
|---|---|
| A1 | Heading emphasis keeps its weight, italic face and strike through restyling; real-font native tests pass. Caret movement continues to hide markers, as the existing contract requires. |
| A3, A4 | Explicit text-first intents join heading starts with the previous line and toggle the common heading level off; portable no-op/demote intents remain available unchanged. Core, FFI and native key-transport tests pass. |
| B2 | Native triple-tap handles/callouts remain active; delayed smart-selection expansion no longer overwrites the logical line. Native classification actions still delegate to Android. |
| C1, C2 | Select All retains the viewport and native selection paint reaches the scrolled top edge. Android 9 and Android 16 regressions pass. |
| C4 | Mixed written lines wrap in one fence and one Undo restores exact Markdown. Core and native mixed-note regressions pass; the original crash stack was not available. |
| D1, D2, D3 | Rust reports selection-wide formats and eligibility. Native selected-word/reopened-toolbar tests pass, and fully selected list rows include their rendered markers in the highlight. Partial-word selection leaves markers unhighlighted. |
| A2, F1 | Repeated collapsed format toggles followed by composed input pass in ordinary and distant headings, without lost text or IME resets. The original intermittent report has not reproduced in these fixtures. |
| B1 | Existing focused, unfocused, jitter, fling and composing-word double-tap fixtures pass; no speculative double-tap change was applied. |
| C3 | The mixed-note Select-All-shaped Quote fixture succeeds in Rust. Commands retain the existing rule that code stays opaque; the supplied note is mostly code after its unclosed fence. |
| E | Queue cancellation and accepted-input preservation pass. Indexed Rust planning removes measured quadratic work. The supplied-note Select All responds in 62 ms and completes background rendering in 13.40 s, compared with the original 81.89 s blocking apply. Fully shown H1, Quote and Code block respond in 1.41/1.33/0.59 s, with complete rendering in 16.19/1.51/15.34 s. All ten block controls complete in one process without OOM after terminal buffers are released. Explicit 20k-line quote typing falls from 140.66 ms to 0.27 ms on the optimized host. Full measurements and limitations are in `docs/spec/editor/performance.md`. |

The editor/core suite passed 641 tests (one ignored), the FFI contract passed 11, and both Android
flavors passed 479 JVM tests each and compiled. Android 9 compatibility/interaction checks pass,
including the real-font, marker, triple-tap, selected-word/reopened-toolbar and first-frame cases.
Android 16 focused regressions pass, including Bulk 9, Streaming 16, Caret Follow 8, Leave 3,
Scroll Restore 3, Toolbar Selection 2 and Migration 7. The umbrella and prepush checks still fail 97 inherited store
tests: an archived starting-commit control has the same failures plus one corrected stale fixture,
with no new store failures. The two apparent store deadlocks were stale final-LF assertions before
gate release; their fixtures and panic cleanup are corrected without changing save behavior.
Additional strict migration fixtures distinguish raw/live source from canonical persisted final LF,
and test pending-worker responsiveness without requesting an input connection before readiness.

Two final performance regressions were reproduced and fixed: an empty display delta at the note's
end widened a 6k repaint to the whole document; closed editors retained large renderer/mirror
payloads across successive benchmark actions. The native repaint regression verifies that the
unchanged tail is not measured, and terminal-disposal tests preserve scroll capture and failed-save
retry/checkpoint ownership. A permanent unbounded GC-root leak was not established.

The original private input remained unchanged. Its emulator copy and owned device heap/fixture files
were removed. No private note contents are committed. Physical Gboard and low-end-phone frame
budgets remain unverified; debug-emulator quote typing had p95 17.88 ms with 17/20 on-time frames.

**Text-first only.** No Milkdown changes: nothing in `src/features/editor/milkdown/`, and no
edit to a cross-platform spec line. Each behavior change gets its own spec line tagged
*(Android text-first editor)*, next to the line it diverges from.

Every item follows the same loop: reproduce on a real device with `just puppet`, write a failing
test at the narrowest owner (Rust `crates/futo-notes-editor/tests/` for a rule, Android
`androidTest/.../textfirst/` for view behavior), fix, then run the owner chain
(`apps/android/AGENTS.md`, plus `just test-rust` when Rust changes) and update the spec line.

## Decisions taken

| # | Decision |
|---|---|
| 1A | Bold, italic and strikethrough are allowed inside headings. Fix the rendering; the spec already allows it (`docs/spec/editor/markdown-elements.md:3`). |
| 2A | Backspace at a heading's visible start deletes the line break before it. A blank line above disappears and the heading stays a heading; a text line above takes the heading's text (Google Docs style). |
| 3A | Tapping the active H1/H2/H3 again turns the line back into Text, in the text-first editor. The cross-platform lines in `toolbar-commands.md` ("does not cycle") and `portable-core/block-commands.md:7` ("already-selected heading level is a no-op") stay; a tagged text-first line records the difference. |
| 4 | A format lights up only if the whole selection carries it. Commands the engine would refuse are dimmed (not hidden). Provisional — revisit after Mason uses it. |
| 5A | Code block on a multi-block selection wraps all selected lines in one fence. |
| 6 | Received the supplied giant note (2,377,842 bytes, 160,005 lines). Use emulators for most work and the connected Pixel 7a for physical checks, in dev builds. The note has an unclosed fence at line 2,274, so most of its heading-looking text is opaque code. Keep the private input outside git. |
| 7 | Clarified: the rendered number beside a selected numbered-list item lacks the selection highlight. Separately, selecting a fully formatted word fails to light Bold/Italic/Strikethrough in the toolbar, including after reopening it. |

## A. Heading rules

**A1 — Emphasis in a heading renders as plain semibold (1A).**
Cause (confirmed in code): `TfHeading.apply` in `textfirst/TextFirstSpans.kt` sets
`paint.typeface = look.semibold`, overwriting the bold/italic typeface the emphasis span set.
Strikethrough survives because it is a separate paint flag. Fix: the heading span sets size and a
base weight; emphasis picks bold/italic variants of the heading face (bold = heavier than
semibold, italic = semibold italic). Second half: Mason saw no `*` markers. Check whether the
caret-reveal of emphasis markers (`TextFirstEditTextReveal.kt`) skips heading lines, and whether
the engine projection carries emphasis records inside headings at all.
Test: androidTest asserting the typeface on `# **a** *b* ~~c~~` lines, plus reveal of markers with
the caret inside.

**A2 — Can't add bold/italic/strikethrough to a heading (on a longer note).**
Likely the same root as F1 ("typing produces nothing" after toggling formats): the engine's
carried formatting state or the toggle refusing on that range. Reproduce first; it was
note-dependent, so it may need Mason's note (decision 6). Owner: Rust `toggle_format` in
`crates/futo-notes-editor` and `EditorEngine.toggleFormat`.

**A3 — Backspace at a heading's start (2A).**
Rust rule (portable core), not Kotlin. Find the current "backspace at line start of a heading
demotes it" path in `crates/futo-notes-editor/src/session/` and replace it: join with the
previous line, removing a blank line wholesale. Edge cases to pin in tests: heading is the first
line (keep today's demote — nothing to join), previous line is a list item / quote / code fence /
table (join rules already exist for paragraphs — reuse them), heading inside a quote.
Spec: new tagged text-first line in `docs/spec/editor/portable-core/interpretation-and-input.md`.

**A4 — Heading can't be turned off (3A).**
Rust `block_command` for `Heading(level)` when every touched line already has that level → apply
`Heading(0)`. Android keeps the Text button hidden. Milkdown keeps its no-op. Test: `crates/futo-notes-editor/tests/blocks/toggle.rs`.

## B. Selection gestures

**B1 — Double-tap doesn't select a word.**
The spec says double-tap is the platform's (`docs/spec/editor/cursor/native-touch-and-focus.md:31`).
Suspects: `LineSelectTouch` (third-tap claim) or `TextFirstTapGesture`/link/checkbox touch
handlers consuming the second down; a selection set by the engine echo overwriting the
platform's word selection. Reproduce on device with a touch trace; androidTest via
`TextFirstTapGestureTest`.

**B2 — Triple-tap alternates between showing and not showing selection handles.**
`LineSelectTouch.selectLine` sets the selection programmatically; Android only shows handles
when its own selection action mode starts. The alternation fits `taps` state not resetting the
same way on both paths (it resets to 0 after the third tap, so a fourth quick tap counts as a
first). Fix: start the platform selection mode (handles + callout) explicitly after `selectLine`,
and reset tap state on every claimed sequence. Test: `TextFirstTapGestureTest`.

## C. Select All

**C1 — Select All jumps the view to the bottom.**
`EditorEngine.selectAll` → `select(0, len)` → the selection echo reaches the view and
`bringPointIntoView(selectionEnd)` scrolls to the end. Fix: a programmatic Select All does not
reveal the caret (the platform EditText keeps the scroll position). Test: scroll offset unchanged
across Select All.

**C2 — Select All highlight is a painted overlay that doesn't reach the top.**
Probably the chunked Editable / progressive-open path: the highlight is drawn only for laid-out
chunks, or the top of the scroll content (title area, first-line margin) is outside the
EditText. Need a screenshot from Mason (or reproduce with a long note). Owner:
`ChunkedEditable.kt`, `TextFirstEditTextScroll.kt`.

**C3 — Select All + Quote does nothing on a large mixed note.**
Either the engine refuses (a selection that touches a code block or table, or the parked final
empty line — `toolbar-commands.md` "A block format never lands on the empty line…"), or it is
the perf stall in §E still queued. Reproduce with a mixed fixture (headings, emphasis, lists,
code, table). If refused, it must at least quote the eligible lines, matching desktop.
Test: Rust `tests/blocks/toggle.rs` with a Select-All-shaped range.

**C4 — Select All + Code block crashes the app (5A).**
Get the crash: `adb logcat` / the app's crash log for the stack. Rust `code_block_command`
(`crates/futo-notes-editor/src/session/blocks/commands.rs`) or the Kotlin window/span rebuild
after a whole-note change. Fix to 5A: one fence around all selected written lines, one Undo step.
A Rust panic across UniFFI must surface as an error, never abort — check that path too.
Spec: `docs/spec/editor/portable-core/fenced-code.md`.

## D. Toolbar state

**D1 — Toolbar reflects the selection, not just the caret (4).**
`toolbarActive(caret)` in `textfirst/TextFirstToolbar.kt` reads `CaretState`, which describes
the caret only. The engine must report, for the current selection: formats carried by the whole
selection, the common block kind (heading level / list / quote / code) or "mixed", and which
commands it would refuse. Add that to the Rust caret/selection query (one FFI call, editor thread)
rather than computing it in Kotlin (rule: note rules live in Rust).

**D2 — Dim what can't be done.**
Wire `disabledFormats` (already supported by `ui/EditorToolbar.kt:109`) from D1's refusals.
Starting rules: inline formats disabled inside code; Indent/Outdent disabled where nothing would
change; Undo/Redo disabled with empty history. Tagged text-first spec line in `toolbar-commands.md`.

**D3 — Selected list numbers lack selection paint; format buttons do not reflect the selected word.**
Decision 7 refers to the rendered numbered-list marker in the note, not a heading or toolbar
number. Paint that marker's selected background through the native view's selection rendering.
Separately, verify D1's whole-selection state through actual word selection and toolbar
collapse/reopen, including Bold, Italic and Strikethrough. Existing toolbar text labels already
receive the active tint; do not change heading labels on this premise.

## E. Large-note performance (supplied note available)

Symptoms: toolbar commands and selection on a large note take up to 2 minutes, stack up, and the
note can't be left; typing in a large quote is slow; removing a list from one item in the middle
of a large note is slow.

Facts from the code:
- Every toolbar tap is `handler.post` onto the editor thread (`EditorEngine.command`). Nothing
  coalesces or drops queued taps, so a slow command plus repeated taps queue up — that is the
  "stacks up" behavior, and leaving the note waits behind the queue.
- `docs/spec/editor/portable-core/long-regions.md:14`: quoted containers remain region-sized —
  every keystroke in a quote reparses the whole quote. That matches "slow typing in a large quote".
- Select All then a block command touches every line, then rebuilds spans for the whole note.

Plan:
1. Keep the synthetic mixed ~20k-line and 2k-line quote fixtures, and measure the supplied
   160,005-line note as a private local fixture. Its unclosed fence is part of the repro;
   preserve the source and measure the actual interpretation.
2. Measure with the existing harness (`TextFirstTypingBenchmarkTest`, `KeyLatencyWindow`,
   `MainThreadWatchdog`) on emulators and the Pixel 7a: Select All, each block command on Select All, list toggle
   on one middle item, typing in a 2k-line quote. Split time into Rust command, FFI, span
   planning, and Android layout.
3. Fix by cause. Expected candidates: cut long quotes into rows like lists and fences
   (`crates/futo-notes-editor/src/inline/row/split/`); make the post-command restyle cover only
   the changed window; never let a single-item list toggle stage a whole-region window.
4. Queue control: while a command runs, further toolbar taps are dropped (not queued), and
   leaving the note cancels queued work. Leaving must never wait on the editor thread beyond
   the save checkpoint.

Bar: the project's current one — zero late frames on the low-end reference phone for typing;
the authorized Pixel 7a substitutes for this session's physical checks and cannot prove that
low-end budget. A whole-note command finishes in a bounded, measured time with the UI responsive throughout. Record the numbers in
`docs/spec/editor/performance.md`.

## F. Typing produces nothing after format toggles

**F1.** Repeated bold/italic/strike toggling with a collapsed caret sometimes swallows typed
text. The collapsed toggle changes "carried formatting" (`EditorEngine.command` comment) with no
document change. Suspects: carried state plus IME composition (Gboard's composing region being
replaced by an empty commit), or empty marker pairs (`****`) being dropped by the engine's
cleanup. Reproduce with a scripted toggle/type sequence via puppet and with real Gboard; then a
Rust test for the carried-format sequence and an androidTest through `EngineInputConnection`.

## Order

1. C4 crash and F1 swallowed input (data/trust problems).
2. E instrumentation and queue control (unblocks judging every "does nothing" report — several
   may be the stall).
3. A1, A3, A4, C1 (well-understood, small).
4. B1, B2, C2, C3.
5. D1, D2 and D3 with the clarified numbered-list and selected-word cases.
6. E structural fixes against the supplied note and the synthetic list/quote cases.

Each item: its own commit, `type(scope): summary`, body with root cause and a `Verified:` line.

## Open questions

- Decision 4 is provisional; confirm with Mason after D1/D2 ship to his device.
