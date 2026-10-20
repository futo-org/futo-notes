## Performance

- Typing is sacred (M5): per-keystroke editor work must not scale with document
  size. The budget is a **16 ms p95 synchronous keystroke at every note size**,
  and it is enforced two ways — the desktop performance floor in the editor
  gauntlet, and the same stories against the real native Android app on the
  low-end reference phone. → tests/editor-gauntlet/performanceFloor.ts
  `PERFORMANCE_BUDGET`, tests/editor-gauntlet/milkdown-performance-floor.spec.ts,
  tests/android-editor-perf.mjs, `just gauntlet-milkdown-perf`,
  `just test-android-perf`
- Opening a note is budgeted at **under 1 s at the sizes real notes reach**, and
  above them cost must scale LINEARLY — no cliff. The floor holds a fixture's
  per-unit open cost to within 2.5x of its smaller reference, which catches a
  scaling wall rather than policing constant factors. →
  tests/editor-gauntlet/performanceFloor.ts
- The debounced `change` notification and `getContent()` serialize the note per
  top-level block, cached on ProseMirror node identity, so a settled edit costs
  the blocks it touched rather than the whole note; the bytes are identical to
  the serializer writing the whole document, which is also what `getMarkdown()`
  and a copy's plain text use (`just chunk-census --serialize`). A document
  whose cache is still cold primes it in idle slices and reports the change
  once primed, instead of serializing the whole note on the main thread. →
  packages/editor/src/markdown/cache.ts,
  milkdown/serializationLoop.ts `createDocumentSerializer`/`readSerialized`
- A note of 400 lines or more is opened PROGRESSIVELY: the first chunk is
  parsed and mounted synchronously so the first viewport is interactive, and the
  rest stream in idle slices. The first chunk is sized to the editor's viewport
  — about a screen and a half of lines at an estimated 24 px a line, never
  fewer than 30 or more than 160, and 80 when the viewport cannot be measured —
  so a phone parses only what it can show. → milkdown/markdownChunks.ts
  `firstChunkLinesForViewport`
- While the tail streams, a pointer down, focus or key in the editor holds the
  next idle slice until 150 ms after the last such event, so no chunk parse
  starts in the frames that place the caret (a slice already running when the
  finger lands still finishes first). An unbroken run of events holds for at most
  1 s, then slices run again until the events pause. A held slice is delayed, never
  dropped: the stream still completes exactly once and the save lock below is
  unchanged. The serializer's idle cache priming yields the same way. →
  milkdown/interactionHold.ts, milkdown/progressiveLoad.ts
  `createYieldingIdleScheduler`, tests/editor-embed-milkdown.spec.ts
- Chunk boundaries are only ever taken where a chunk
  parses to the same document the whole note would (never inside front matter,
  never at a `---`), and a chunk that parses to nothing aborts the whole thing
  back to a single whole-document parse. → milkdown/markdownChunks.ts,
  milkdown/progressiveLoad.ts, `just chunk-census`,
  docs/evidence/milkdown-chunk-census.md
- A chunk may also begin without a preceding blank line, at a column-0 ATX
  heading, fence opener, blockquote start, or list item CommonMark lets
  interrupt a paragraph — so a note with no blank line anywhere can still
  open progressively. → milkdown/markdownChunks.ts

  The desktop window can still be closed during that freeze (RC-37): the close
  is JS-mediated (`startNativeShell.ts` `onCloseRequested`), so before
  2026-09-30 a close request made 8 s into a 100,000-line block was ignored
  for 70 s (until the parse ended). `close_deadline.rs` now arms on the first
  `CloseRequested`; if the app is still alive 5 s later (the JS handler's own
  3 s flush race plus 2 s margin) AND the page reports nothing unsaved, Rust
  waits for any in-flight vault write (the process-wide `vault_mutation_guard`,
  at most 5 s more) and exits without the JS thread. A note open is not an unsaved
  edit (a note switch awaits the outgoing save before the next note is opened —
  it may READ the next note's file meanwhile when that save cannot touch it —
  and the page cannot be typed into while it parses), so the open case is exactly
  what the deadline cuts. A page that does hold an unsaved edit is not cut at the
  deadline, however long its JS thread stalls (an 8 s task, a 2.5 MB paste): the
  page tells Rust on every clean/dirty transition, reports at once from the
  editor's own transaction dispatch (any document-changing transaction, so
  keymap commands, toolbar and checkbox clicks count as well as typing; sidebar
  clicks do not) and on `beforeinput`, `paste`, `cut` and `drop` (before the
  stalling work begins, since the save queue only learns of an edit after the
  editor's own 200 ms debounce), and Rust waits for the JS handler. That wait
  ends early when the page that set the flag is gone (WebKitGTK's
  `web-process-terminated`, or a new page load; WKWebView and WebView2 are not
  hooked) and is capped at 60 s from the first close request, because a window
  must always be closable: a stall longer than that with an unsaved edit (a
  ~5 MB paste on WebKitGTK takes ~80 s) loses it, with one log line. Measured: exit 5.4 s after the request with the
  giant note's bytes unchanged; 8 s busy loop, 2.5 MB paste and 2.5 MB replace
  each exit when the stall ends with the edit on disk; a responsive page with an
  unsaved edit still drains it through the JS handler and exits in 0.1 s. The
  JS handler also no longer abandons a write that is still running after its 3 s
  race (up to 15 s), which on a slow disk used to lose the edit and leave a
  `.sf-tmp-*` file. The freeze itself remains the gap. →
  apps/tauri/src-tauri/src/close_deadline.rs, closeDeadlineDirty.ts,
  startNativeShell.ts, tests/desktop-close-deadline.mjs

- While the tail is still streaming, content cannot leave the editor as a
  PREFIX: `change` is suppressed. A native `flush` returns the host's
  original bytes when untouched, or settles the tail before reporting an edit.
  Desktop component reads use the same complete-document serialization. A pinned
  `role="status"` bar reads "Loading the rest of this note…" while it runs, and
  the streamed appends are not undoable. → milkdown/hostHandle.ts `flush`, `getContent`,
  milkdown/progressiveLoad.ts, tests/editor-embed-milkdown.spec.ts
- Every top-level block is rendered eagerly; the editor applies no
  `content-visibility` containment. A Chromium-only containment rule ran from
  #106 until 2026-09-05 and was retired after measuring it against eager
  rendering on the low-end Android reference phone: with off-screen blocks
  skipped, the FIRST focus of a note stalled quadratically (3 s at 500 blocks,
  12 s at 1,000, 48 s at 2,000 — a real tap into a 4,000-line note froze the
  app), focused typing was no faster, and open time was the same. Eager first
  focus is 176 / 202 / 379 / 810 ms at 500 / 1,000 / 2,000 / 5,000 blocks. The
  rule also painted holes on Apple WebKit, so all three engines now render
  alike. → milkdownEditor.css (the comment where the rule was),
  docs/plan/milkdown-transition.md §5 "Containment retired",
  tests/editor-embed-milkdown.spec.ts
- The FIRST focus of an opened note — the tap that starts typing — is budgeted
  at **under 1 s at real-note sizes** on the reference phone and measured for
  every fixture, blurred again before the keystroke loop so the keystroke unit
  stays the desktop gauntlet's. → tests/lib/editorDevicePerf.mjs
  `DEVICE_BUDGET.firstFocusMs`, tests/lib/editorDevicePerfSnippets.mjs,
  tests/android-editor-perf.mjs
- Decoration repaints are bounded to the textblocks a transaction changed, never
  the document: tag decorations and fenced-code highlighting re-derive only
  the blocks that moved, and a task checkbox edit rebuilds only the affected
  item even inside a long nested list. A fence over 20,000 characters is left uncoloured
  rather than paying for it. → milkdown/blockDecorations.ts,
  milkdown/tagDecorations.ts, milkdown/codeHighlight.ts
- Per-keystroke work does not scale with the number of links on screen times the
  vault. Rendering a wikilink needs the whole note-id list twice — once to resolve
  the target, once for the shortest unique display suffix — so both go through one
  index (`getWikilinkIndex`), never per link; `[[` completion shares it. The
  index is rebuilt whole whenever the note list changes, which a save
  mid-typing does, so the keystroke after an autosave pays one pass over the whole
  vault — tens of ms at 8,000 ids and over 100 ms at 50,000 in a Node
  microbenchmark of the build alone, never measured in a shipped engine, so treat
  those as a floor: a very large vault pays a real hitch there, and profiling it
  against these numbers will mislead. → wikilinks.ts, notes.svelte.ts
- One large insertion (a paste) costs time proportional to the pasted size, not
  its square. `tests/paste-perf.spec.ts` compares the same paste at 1,250 and
  5,000 items and bounds the RATIO rather than a duration, because a busy machine
  inflates both sizes alike but only a quadratic inflates the ratio. Measure a
  paste with a real paste event: CDP `Input.insertText`
  (`page.keyboard.insertText`) splits a multi-line insertion into quadratically
  many browser editing operations and is quadratic even against a bare
  `contenteditable` carrying no application code, so it measures the harness, not
  the editor (M21). → tests/paste-perf.spec.ts
