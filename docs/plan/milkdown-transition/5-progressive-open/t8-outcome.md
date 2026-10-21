### T8 outcome (#105, done)

Built as two modules under `src/features/editor/milkdown/`: `markdownChunks.ts` decides WHERE a
document may be cut, `progressiveLoad.ts` decides WHEN each piece reaches the editor.
`MilkdownEditor.svelte` wires them and owns the save lock. Notes under 400 lines — everything in an
ordinary vault — are untouched and load exactly as before.

**The equivalence proof.** `scripts/milkdown-chunk-census.mjs` (`just chunk-census`) drives the real
`editor.html` over the 31k-note corpus through a `?census` hook, comparing a chunked parse against a
whole-document parse of the same note at the FINEST granularity the planner allows — a cut at every
boundary it can find, ~15 chunks per note on average. Run against this ticket's own base (the chain
before T4/T5 landed): **25,344 notes took the progressive path and every one of them parsed
identically chunked and whole; zero divergent, zero crashes, all 30,995 notes processed**
(`docs/evidence/milkdown-chunk-census.md`). Six notes were abandoned by the loader mid-flight and are
excluded rather than scored as matches — for those it compared a whole parse against a whole parse,
which proves nothing.

**Re-run after the merge with T4/T5, and it found a crash that is not ours.** The wikilink, tag,
task-checkbox and fence-highlight plugins change the chain, so the census was re-run on the merged
branch. Still zero divergences — but 1,581 notes (5.1%) now fail to load at all: on
`feat/milkdown-editor` at 4b6cd5d4, with no progressive-open code present, `FutoEditor.initialize`
throws `Cannot close 'paragraph': a different token ('wikilink') is open` for any note whose line
ends in `!`. Minimal repro: `"!"`. Also `"hi!"`, `"# hi!"`, `"hi!\n\nmore"`; `"hi! there"` is fine.
The extension opens an embed token on the `!` expecting `![[` and never closes it. That is #101's to
fix — it breaks the epic's "the editor never refuses to open a markdown file" outright — and it is
recorded here because the census is what surfaced it.

**The criterion is met against TODAY's plugin chain, not the final one.** #105 asks for equivalence
"with the final compat plugin chain", and #99 — which replaces the preset's empty-line plugin and
adds the empty-link and bullet-number fixes — is still open. Re-running `just chunk-census` after
#99 lands is the outstanding half of this criterion; the report says so in its own text so a reader
of the numbers cannot miss it.

It got there by finding real bugs, none of which a hand-written test suite would have proposed:

- `trailing`'s placeholder paragraph was being carried along instead of consumed, leaving every
  streamed document one empty paragraph longer than the same note parsed whole (23 of the first 23
  divergences).
- The scanner lost "we are inside a list" at an indent-0 lazy continuation or an indented fence, so
  it cut loose lists in two — and two adjacent lists must be serialized with different bullets
  (`*` then `-`, `3.` then `3)`) or they merge back into one. 73 divergences.
- A backtick fence whose info string contains a backtick (```` ```toml` ````) is a PARAGRAPH in
  CommonMark; reading it as a fence opened one the scanner never closed.
- A fence opened inside a list item cannot be closed by a line at column 0.
- An empty list item (`- ` with nothing after it) means different things depending on the block
  above it, so a cut in front of one is never safe.
- 78 notes CRASHED the editor: `formatState` computed a mark range against `view.state.doc`, which
  is one transaction behind, and a chunk append is a doc-changing transaction that also moves the
  caret — so the range could point past the end of the doc it was evaluated against.
- A chunk holding only `<br>` parses to nothing (the preset's empty-line plugin removes the node
  and the chunk boundary took away its context). The loader now refuses a chunk that parses to
  nothing and reloads the note whole; root-causing that plugin stays **#99**'s job.

**The save lock is red-proved, not asserted.** Deleting both of its doors — the `progressive.loading`
early return in the change listener and the one in `getContent()` — turns
`killing the app mid-stream leaves the note file byte-untouched` red, along with the two in-memory
lock cases. That test writes a real file from a fake host that autosaves every `change`, then closes
the browser context mid-stream. Its first version did NOT have teeth: it closed the context within
milliseconds of chunk 0, before the change listener's own 200 ms debounce could have delivered
anything, so the file came back untouched whether the lock existed or not. It now sits mid-stream
for three debounce windows first.

**Two save-lock holes the tests found, both truncation:**

- Milkdown's listener serializes the document from the transaction that STARTED its 200 ms debounce,
  not the live one, and it ignores `addToHistory: false` transactions entirely — so the first
  `change` after a progressive open could carry the note as it stood mid-stream, arriving one
  debounce window after the lock lifted. The change path re-reads the live document for that one
  callback.
- "Did the user type while the tail streamed?" cannot be answered by classifying transactions: the
  preset re-stamps heading ids in a 125-step transaction after content lands, which reads as typing
  and would have rewritten every large note on open. It is answered by `undoDepth` against a
  baseline the component keeps in step with its own `resetHistory()`.

**Open budget, redefined and measured.** `performance.measure` entries
`futo:editor-open-interactive` (first chunk mounted) and `futo:editor-open-complete` (save lock
released) — ordinary platform entries, so Playwright, DevTools and a CDP session on a real phone all
read the same number. The desktop assertion lives in `tests/editor-embed-milkdown.spec.ts`;
enforcing the same measure on the low-end Android reference device is **#106**.

**Where the planner gives up, measured.** Of the 579 corpus notes past the 400-line threshold, 515
(88.9%) take the progressive path; the other 64 decline and load exactly as they did before
(37 carry a link-reference or footnote definition, which resolves document-wide, and 27 offer no
safe boundary at all). The first chunk's budget is 80 lines and the planner takes the first SAFE
boundary at or after it, so a note that offers none early gets a bigger first chunk than the budget
asks for: p50 86 lines, p90 139, but 6 notes of 515 over 500 and one at 2,700. Those few open no
worse than they do today — they just do not open better. Tightening that would mean cutting
mid-block, which is the one thing the census proves is unsafe.

**Not done here:** the spec lines. `docs/spec/editor.md` still describes the CodeMirror editor and
carries no Milkdown behavior at all — per D9 and ADR-0002 the existing lines stay in force until the
swap, and the new progressive-open lines belong to the spec-renegotiation MR (**#109**), which
should write them from this section.
