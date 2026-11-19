# How fast editors handle very large files

Researched 2026-11-02 for the desktop editor. Mason dropped the gigabyte-note goal for now; this
records what other editors do in case it returns.

## EmEditor (opens up to 16 TB)

- Multi-threaded open; the file is usable while it loads.
- Above 300 MB it switches to disk-based mode and **turns word wrap off**. Wrapping needs every
  line laid out, so that is the first thing it drops.
- Fast View (v26.3, files of 4 GB and up) indexes line starts on a background thread and reads only
  the visible lines. Line numbers appear once the index is built.
- Fast View editing (v26.4) keeps edits in memory and can save only a **diff file** that also stores
  the line index. A 48 GB file reopens in 0.02 s.
- Heights are exact only because every row has the same height: rows × line height, and the
  scrollbar is a row index (inferred; EmEditor doesn't document it).

Sources: emeditor.com large-file-support page, the v26.3 and v26.4 release notes, its file FAQ.

## The common pattern

- Height = count × a fixed row height. Sublime, klogg, Hex Fiend, Zed, Xi and VS Code all do this.
  Zed and Xi lay out every line in their own renderer, Zed spending at most 5 ms in the foreground
  and doing the rest in the background.
- The scrollbar maps to lines or bytes, not pixels: EmEditor, klogg, Hex Fiend, Fresh, and
  CodeMirror 6's `BigScaler` once the content passes 7e6 px.
- The text lives in native code and is indexed in the background: a piece tree, a memory map or a
  block index. Only the visible window is read.

## Measured: the whole-DOM renderer at 58,000 lines (2026-11-04, macOS WebKit)

- One element per line under one parent: every edit re-laid out all of them, 330 ms in the
  keystroke plus 460 ms in the next frame, and the first layout took 1.2 s.
- Lines in 512-line chunks, each chunk its own compositing layer (`will-change: transform`): about
  1 ms of our work and a 1 ms frame per keystroke, and 0.7 s to first lay the note out
  (`src/features/editor/desktop/lineElements.ts`). Smaller chunks cost more: 9 ms an edit at 64.
- Without the layers, the frame after an edit stays near 8 ms: WebKit repaints and recomputes
  event regions over the whole layer holding the note.
- `content-visibility: auto` on the chunks is unsafe. A selection cleared while a chunk was skipped
  stays painted in it (select all, click, scroll down). On each line it makes one layer per line,
  and WebKit inserts layers in quadratic time, which hung the page.

## Measured: a whole-note selection (2026-11-05, macOS WebKit)

- Scrolling with all selected costs more the longer the note, window key or not. On every
  selection change and each time a scroll comes to rest, macOS Writing Tools
  (`WTAffordanceUIController`) asks the web view for the selection's first rect and its attributed
  text. WebKit answers each by walking the DOM text from the editable root
  (`EditingRange::toRange`, `resolveCharacterRange`), so each answer costs the whole note: at
  160,000 lines, about 375 ms more web-process CPU per wheel gesture than with a caret, nearly all
  of it these queries.
  A web view made with `writingToolsBehavior = None` (it reports -1) still gets them after every
  scroll: WebKit still sends `textInputClientDidUpdateSelection` when a scroll comes to rest
  (`WebViewImpl::contentRelativeViewsHysteresisTimerFired`), and AppKit's affordance still asks.
  The configuration is copied when the web view is made, and nothing changes it later.
- Select All itself stalls the page about 0.5 s at 160,000 lines (2.9 s in one run; 140 ms at
  58,000), Writing Tools on or off: `RenderSelection::set` and the editor state's selection geometry
  visit every selected line. Only fewer selected elements (virtualization, or our own selection
  paint) cuts that.
- A 2.4 MB paste into an empty note: 0.3 s engine, 0.3 s line model and DOM, 0.8 s first style and
  layout, forced by placing the caret (`setBaseAndExtent`).

Select All, then 12 real wheel scrolls, Writing Tools on as shipped (2026-11-05, notes made from the
first lines of a `## Section` / body-line note, window not key):

| Lines  | Select All stall | Scroll stall, caret (p50 / max) | Scroll stall, all selected (p50 / max) | Writing Tools queries, 12 scrolls |
| ------ | ---------------- | ------------------------------- | -------------------------------------- | --------------------------------- |
| 5,000  | 35–144 ms        | 0 / 23 ms                       | 0 / 200 ms                             | 77 + 97 ms                        |
| 20,000 | 204–278 ms       | 25 / 35 ms                      | 35 / 138 ms                            | 309 + 241 ms                      |
| 50,000 | 74–538 ms        | 59 / 161 ms                     | 66 / 77 ms                             | 778 + 526 ms                      |

- A scroll's stall is the longest main-thread gap from its wheel burst to the next one. Both
  columns include Puppet's own receipt reads, two a scroll (about 24 ms each at 20,000 lines, 55 ms
  at 50,000), which a person does not pay. Select All is the first stall after WebKit's
  `selectAll`, three runs each; one 50,000-line run stalled only 74 ms.
- Queries are `sample` time in `FirstRectForCharacterRange` and
  `AttributedSubstringForCharacterRange`, one round a scroll: about 15 ms a scroll at 5,000 lines,
  46 ms at 20,000 and 109 ms at 50,000, about 2 ms per 1,000 lines. At 20,000 they land as one or
  two 25–35 ms stalls when the scroll stops. A second 20,000-line run gave 29 / 33 ms selected and
  22 / 142 ms with a caret.

## If the desktop editor needs virtualization

Skipped for the first version (Mason, 2026-11-02): measure the whole-DOM renderer first. If it
falls short, this is the plan the research supported:

- Keep only the blocks near the viewport in the DOM. On the `perf/zero-lag` spike, hiding every
  block after the 400th cut a full restyle on WebKitGTK from 1,008 ms to 88 ms. An 80k-block note
  took about 1 s per full restyle and 250 ms per width change
  (`docs/learnings/large-note-webkit-reflow.md` on that branch).
- Store the scroll position as an anchor: a block plus a px offset into it. When an estimate is
  corrected, restore the anchor yourself. CodeMirror 6 sets `overflow-anchor: none` and does this
  by hand. Native scroll anchoring in WebKit isn't confirmed (bug 171099).
- Height per block, in this order: its measured height, cached by width and style revision; an
  exact value for code (lines × line height) and images (intrinsic size); otherwise an estimate for
  prose from characters ÷ measured characters per row. Measure off-screen blocks in idle chunks,
  so typical notes end up exact.
- Above about 7e6 px, scale the scrollbar or count it in blocks, as CodeMirror 6's `BigScaler`
  does. An element can't be taller than about 33.5M px.
- The engine already owns selection, find, copy and Select All, so none of them needs the whole note
  in the DOM. Screen readers and spellcheck see only what's drawn.
- Don't count on `content-visibility: auto`: the spike saw no gain on WebKitGTK. Pretext was
  rejected on 2026-10-26: it doesn't cut the style and layout cost of blocks already in the DOM, it
  has no caret or hit testing, and its line breaks are wrong in thousands of known cases.
- Full research report with sources: CodeMirror 6 `heightmap.ts` and `viewstate.ts`, Zed
  `wrap_map.rs`, klogg `abstractlogview.cpp`, and Eric Meyer's "Infinite Pixels" (2025).

## Limits for a webview editor

- No method gets exact heights for wrapped, proportional, mixed-size text without the webview laying
  all of it out. Pretext and canvas `measureText` have thousands of known wrong line breaks in each
  browser engine.
- An element can be at most about 33.5M px tall, roughly 1.4M rows at 24 px.
- WASM memory is capped at 4 GB, WebKit has no Memory64, and a V8 string holds about 2^29 units.
  A multi-GB note can't live in the page.
- Gigabyte notes would need the text and index in Rust, serving windows to the page through
  `project()`, with wrap or exact heights given up above a size threshold.
