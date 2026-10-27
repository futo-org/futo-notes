### The one-paragraph note: measured, capped, then actually fixed (2026-09-01)

§5 said a note the planner declines "opens no worse than it does today". For one shape that was true
and useless: a note with **no blank line anywhere** could not be opened at all. A user's 50,000-line
note (~1.65 MB, every line a sentence) showed a blank editor body indefinitely, and because the iOS
shell cannot read a document that never mounted, Back answered "Couldn't read the latest note.
Navigation is paused while your changes remain pending." on every tap — force-quit or Delete Note
were the only exits. Reproduced on the simulator, 2026-09-01.

**The cost is not the note's size; it is the size of its largest INLINE CONTENT RUN.** Same 1.26 MB
in every row, measured against the shipped `editor.html` in chromium:

| fixture | `initialize` |
|---|---|
| 1.26 MB on ONE line (a single inline node) | 107 ms |
| 20k lines, blank line every 200 | 667 ms |
| 20k lines, blank line every line | 2,264 ms |
| 20k lines, no blank line anywhere (one run) | 7,796 ms |

**First answer, and the wrong one: a cap.** A note past ~4,000 lines / 256 KB in one run mounted a
bounded READ-ONLY preview with a notice saying the editor could not open it. It was safe and it was
fast and the maintainer rejected it on sight — correctly. A 4,280-line note is an ordinary pasted
transcript or log, the CodeMirror editor opens it without complaint, and "more than the editor can
open" is a capitulation with a friendly voice. Reverted the same day; the shell half of that lane
(Back always leaves, `.noLiveDocument` vs `.notOurs`) is independent and stays. Both native shells
now hold that rule: iOS in `editorExitBody` (57cc910a) and Android in the same-named Kotlin
function, whose capture answers `NoLiveDocument` when the bundle has not reported `initialized` or
the renderer does not answer inside a 6 s deadline — the Android trap is the deadline, because
`isReady` is app-lifetime state on the pre-warmed WebView and stays true while `setContent` blocks
the renderer.

**Second answer: make the parse fast.** Two candidate causes, both measured rather than argued.

1. **The hardbreak explosion — real, but NOT fixable this way.** `remarkLineBreak` splits every text
   node at every newline and inserts a `break` node, and the schema renders each as its own
   `contenteditable="false"` span: one paragraph of N lines becomes 2N inline nodes. Dropping the
   plugin took a 4,000-line paragraph from 7,999 inline nodes to 1 — and **destroyed the author's
   line breaks on the first edit**: `alpha\nbravo\ncharlie` saved back as `alpha bravo charlie`.
   The nodes are what make a soft break survive an edit. Not dropped; the cost stands.
2. **micromark's text resolver — fixed.** `resolveAllText` merges adjacent `data` events with one
   `events.splice()` per run, and every splice shifts the whole tail: quadratic in the number of
   runs, and a paragraph of single-newline lines produces one run per line. Patched to collect the
   removals and compact in ONE pass, in place (`patches/micromark@4.0.3.patch`, applied by pnpm;
   upstreamable as written).

| one paragraph | before | after |
|---|---|---|
| 4,000 lines (223 KB) | 481 ms | **163 ms** |
| 10,000 lines (557 KB) | 2,147 ms | **541 ms** |
| 20,000 lines (1.1 MB) | 4,819 ms | **1,622 ms** |
| 50,000 lines (2.8 MB) | 18,100 ms | **8,862 ms** |

**The first version of that patch corrupted text on 3,912 of 4,000 corpus notes.** It returned a new
array where upstream mutates in place, so callers holding the original identity processed the
unmerged events a second time and text duplicated, compounding on every round trip
(`Git plugin Documentation` -> `Git plugin Documentationplugin Documentation`). The census caught it
before it reached the branch; the in-place version is `0 flags cleared, 0 newly raised` against the
same 4,000 notes. This is exactly what the census is for, and the reason a dependency patch here is
not a free action.

**Still open.** 50,000 lines in one paragraph is 8.9 s, and the remaining cost is item 1: 99,999
inline nodes for that fixture, all mounted at once. Fixing it needs inline-level progressive mount
(append inline content into the SAME paragraph, which changes no block structure and so no bytes) —
not a cap, and not dropping the nodes. No note in the 31k corpus has that shape; the largest real
one-run note measured 4,280 lines, which now opens in ~0.2 s.

**Recorded as a spec Gap (docs/spec/editor.md, "Progressive open"), 2026-09-21.** The 8.9 s number
above is desktop Chromium; re-measured on this branch it is faster still (1.06 s at 50,000 lines,
459 ms at 20,000 — `tests/editor-embed-milkdown.spec.ts`'s `oneParagraphNote` test is the live
budget, and it stays green because Playwright only ever runs it on Chromium, M22). This IS
engine-dependent, confirmed by direct triage measuring the same 50,000-line / one-paragraph /
2,543,891-char (~2.5 MB) fixture in the actual shipped app: **desktop Chromium opens it in
0.93–1.06 s**; the identical bundle in the **real Linux Tauri debug app (WebKitGTK, normal window,
GPU compositor) opens it in about 41 s** — 41,014 / 41,221 / 41,321 ms across three runs, via the
app's own `futo:editor-open-complete` mark. `planMarkdownChunks` itself costs ~41 ms to decline
`no-boundary`; the whole ~41 s is the parse/dispatch of one `<p>` with tens of thousands of inline
children. CodeMirror on `main` opens the same file instantly (virtualized DOM). Fixing it for real
needs chunking on soft line breaks inside a single paragraph, not just at block boundaries — a
multi-day follow-up, not a quick patch. On
Android, the same parse cost also blocks the navigation-exit capture (`EditorWebView.kt`'s
`CAPTURE_DEADLINE_MS`, 6 s) with no progress indicator, and can leave the next note's title showing
over the previous note's stale body until its own `setContent` finishes parsing. Follow-ups tracked
in §10.
