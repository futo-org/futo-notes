# Desktop editor: the maintainer's short list, checked on 2026-11-10

Checkout `desktop/new-editor` at `50eda40dc`, the running `just tauri-dev` (macOS, WKWebView,
window never activated), driven with `just puppet`. The scope was cut to the maintainer's
short list: the 104-row sort was not done.

Rerun: `node tests/desktop-editor-ledger-checks.mjs [filter]`.

## Counts

- Baseline: `tests/desktop-editor-stories.mjs` 14/14, `tests/desktop-editor-pointer-stories.mjs`
  11/11.
- `tests/desktop-editor-ledger-checks.mjs`: 12/16 passed at `50eda40dc`. After the fixes below
  three checks were dropped (CS07 Cmd+A, which Puppet cannot press; the PF12 slow-open timing,
  which follows machine load; SV02 note-switch scroll, not decided) and the other 13 pass.

## Results

| Item                                                 | Result          | Evidence                                                                                                                                                                            |
| ---------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Double click selects the word, triple the line       | holds           | pointer story "a click places the caret, a double click selects the word, a triple the line"                                                                                        |
| Cmd+A selects the whole note (CS07)                  | not checked     | Puppet's keys skip the AppKit Edit menu, which owns Select All: eyeball it                                                                                                          |
| Whole-note highlight covers the top row (CS08)       | holds           | checks "CS08 …" (a highlight band under the first and last rows in the pane, short note and a long note scrolled to its middle); screenshots read                                   |
| Whole-note selection does not move the scroll (SV01) | holds           | check "SV01 selecting the whole of a scrolled long note keeps the scroll" (selection through `Select`, not Cmd+A)                                                                   |
| HG02 Backspace at a heading start, blank line above  | holds           | story "Backspace at the start of a heading takes the empty line above, not its level"                                                                                               |
| HG02 … body text above: joins into the body line     | holds           | check: `body` + `# Title` → `bodyTitle`, paragraph, file `bodyTitle`                                                                                                                |
| HG02 … at the note start: nothing                    | holds           | check: `# Title` stays heading1                                                                                                                                                     |
| HG02 … on an empty heading: demotes                  | fixed           | check "HG02 Backspace in an empty heading …" (below)                                                                                                                                |
| Pane follows the caret while typing at the bottom    | holds           | check "SV04 typing …": each of 8 typed lines is inside the pane straight after its keys, before any save                                                                            |
| Pane follows the caret after a long paste            | fixed           | check "SV04 a long paste …" (below)                                                                                                                                                 |
| Heading line height, empty vs one character (CS10)   | holds           | check: same line box (y and h) for `# x` and the emptied heading                                                                                                                    |
| Caret above an H1 at the top, and after H1 + Enter   | holds (measure) | check: `state.editor.caret` lies inside the line box and the pane; caret before `Title` 176–210.7 px, text 176–211 px. The drawn caret is hidden in an unfocused window: eyeball it |
| Scroll after leaving a note and returning (SV02)     | not decided     | tab switch: kept. Open another note in the same tab, then return: reset to the top                                                                                                  |
| Scroll after Undo, Redo, paste (SV07)                | holds           | check "SV07 …": caret's row stays in the pane, scroll moves under 40 px, no jump to the bottom                                                                                      |
| PF12 slow open after live Ranges                     | hardened        | not reproduced; one parked measuring Range (below)                                                                                                                                  |
| Click another note while a large note opens          | fixed           | check "PF12 a click on another note …" and `createTabNoteTransition.test.ts` (below)                                                                                                |

## Fails

**HG02, Backspace in an empty heading: class 1 (broken in slices 1–2).** Type `above`, Enter,
`# x`, Backspace (heading now empty, file `above\n#`), Backspace. The engine is right: `doc`
source is `above\n` and the file is `above\n`. The view is not: `doc` still lists L2 as
`heading1`, and the caret is still heading height (34.68 px). The next keystroke redraws it
as a paragraph (`y` → L2 `paragraph`). The edit that removes only a heading's marker does not
restyle the line it leaves empty. **Fixed:** the engine describes no block for the note's empty
last line, and `LineModel.applyBlocks` left a line starting at the projection's end out of it;
that line is now restyled (body text). An empty body line reads `gap` in `doc`.

**Long paste at the end of a note: class 3 (needs a decision), or 1.** In a new note, type
`top`, then `Paste` 80 lines: the caret is at line 81 (`state.editor.caret.top` 2124 px in the
wrapper), the pane stays at the top, `show "row 80."` is refused as off screen. The editor has
no reveal of its own after an edit: typing is revealed by WebKit's key handling, not by us.
`do Paste` is a verb, not a real Cmd+V (the menu path is out of Puppet's reach), so a real
Cmd+V may differ: eyeball it. The same holds for `do Type` with many lines.
**Fixed:** after every edit the engine applies, the caret's draw scrolls a caret outside the
pane into it with `reveal`'s one-row margin (caret.ts `follow`, overlays.ts `revealFocus`).

**SV02, note switch in one tab: class 3.** Scroll a long note to its middle (textbox y -447),
open "another note" from the sidebar, open the note again: textbox y 153, the top. Switching
tabs away and back keeps the scroll. Whether a note reopened in the same tab keeps its scroll
is the maintainer's call; SV02's restart case was not tried.

**Click another note while "huge note" opens: class 1, intermittent.** From a scratch note
(a double-clicked word in it), click the "huge note" row, then about 340 ms later the scratch
note's row. Once in five tries the app ended with `screen` `editor:Untitled` and the tab
named "Untitled", while the title field, body and `state.note` were "huge note". The trace has
both clicks handled (events 39909 and 39914). `OpenNote Untitled` was then a no-op; opening a
third note and coming back recovered. Typing in that state would edit "huge note" under the
other note's tab. Not reproduced in four more runs of check "PF12 a click on another note …",
which passes today. It may not be editor code (tabs and the note session own the switch).
**Fixed, not editor code:** `createTabNoteTransition` skipped a switch to the note it had last
loaded, even while a switch away from it was still loading, so the click back was dropped and
the huge note's load finished as the session's note. It now compares with where the newest
switch is heading. Reproduced 1 of 1 before, passed 8 of 8 after; the proof is
`createTabNoteTransition.test.ts`. A new empty note gone back to that way was deleted under the
tab by the switch away (`noteSession.svelte.ts` `openLeavingUntouched`); it is kept now
(`noteSessionLoad.test.ts`). Still open: with A loaded, B opening and C asked for, an open of C
that fails leaves the editor on B while the tab and session go back to A.

## PF12

The MRs: !380 found two live DOM Ranges with a boundary inside the content being rewritten
(prosemirror-view's reused measuring Range left by `coordsAtPos`, and the focused selection);
WebKit re-indexes every live Range on each removal (`Range::nodeChildrenChanged`), O(n²).
!459 found a third: `findOffsetInText`'s Range left in the paragraph under the pointer, which
`detach()` does not release. !550 is unrelated stall work (saves, taps, keyboard, Find).

On this branch, `view.ts` `open()` replaces the body with `this.dom.replaceChildren(…)` and
does not park the native selection first, and every line is drawn with
`element.replaceChildren(line.text)` (`lineElements.ts` `drawLine`). Ranges are created and
left for the garbage collector in `caret.ts` `caretViewportRect` (one per caret draw),
`highlight.ts` (one per highlighted line per redraw), `hitTest.ts` `caretPoint` (WebKit's
`caretRangeFromPoint`, when `caretPositionFromPoint` is missing) and Puppet's own `show`.
A hypothesis to test with a profiler: WebKit's `Document::nodeChildrenWillBeRemoved` walks
every live Range of the document on each `replaceChildren`, so building 58,000 lines costs
lines × live Ranges until a collection frees them, which fits "3 s in a long-lived session,
40 ms fresh". Not proven.

Timings, opening "huge note" (62,003 lines) from a three-line scratch note, until `state`
answers `ready` and not `loading`:

| Left in the small note before the open                                     | Open                                 |
| -------------------------------------------------------------------------- | ------------------------------------ |
| caret after typing                                                         | 3,053 ms (first open)                |
| a clicked caret                                                            | 3,108 ms                             |
| a double-clicked word                                                      | 762 ms                               |
| a drag selection over three lines                                          | 710 ms                               |
| caret, then focus taken by the chrome                                      | 945 ms                               |
| a selection in "huge note", 40 wheel scrolls, 300 Down, then away and back | 1,216 ms (1,656 ms before the churn) |

One run measured 20,740 ms after that churn (1,590 ms before), but the load average rose to
244 during it (an iOS simulator booting in another lane), and two later runs at a load under 10
gave 1,216 ms and 879 ms. So the slow open is not reproduced.

Hardened as !380 did: the editor measures through one Range, parked on the document after each
use (lineElements.ts `withMeasuringRange`, also Puppet's `show`); `caretRangeFromPoint`'s Range
is parked; `open()` clears the native selection before it replaces the lines; a new line
element is filled with `append`, not `replaceChildren`. Open of "huge note" from a small note,
load 8–13: before 2182/1662/1480 and 1047/1134/2790 ms; after 3813/3326/1373, 3040/1317/1456,
951/1045/987, 1076/1256/1005 and 877/1192/1240 ms (the first run after each hot reload was the
slow one on both).

## Eyeball in a focused window

- Cmd+A from the keyboard and from the Edit menu: whole note selected, highlight from the top
  row, scroll unmoved, in a short note and a long scrolled one.
- The drawn caret before an H1 at the top and on the line after an H1 + Enter: not clipped.
- A real Cmd+V of many lines at the end of a note: does the pane follow the caret?
- Heading line heights read from boxes only; the drawn caret on an empty heading.

## Not verified

The SV02 restart case, CRLF, input methods, VoiceOver, Windows and Linux. The 104-row sort.

## Incident

A probe script's cleanup (the harness's `inNewNote` deletes whichever note is open) deleted
"huge note" from the dev vault while it was open. It was restored by copying it back from
`/Volumes/coding/.Trashes/501/` with its bytes and mtime (`cmp` equal; the trash copy stays).
The check file uses its own `inScratchNote`, which deletes only its own note.
