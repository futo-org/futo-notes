## 5. Progressive open (the large-note story)

- Parse markdown in top-level-block chunks (blank-line splits, fence/reference-definition aware).
  Mount the first chunk immediately; stream the rest as idle-time appends. The cv stylesheet makes
  offscreen DOM cheap; chunking makes offscreen *parse* deferred.
- **Save lock (CRITICAL)**: while the tail is streaming, no save may fire and the load-echo guard
  holds — serializing a half-loaded doc writes a truncated file. Save unlocks only at
  full-doc-loaded. Needs a test with teeth: kill mid-stream, assert the file untouched.
- Chunk-append transactions are non-undoable and invisible to the change listener.
- **Equivalence proof**: `chunkedParse(doc) ≡ wholeParse(doc)` asserted across the 31k corpus
  (reference definitions and setext edges care about context); the census harness does this in
  minutes.
- Worker-thread remark parse is the second lever, only if measurement demands it.
- **Budgets**: time-to-interactive-first-viewport <1 s and keystroke p95 <16 ms, enforced on the
  low-end Android reference device (Justin's old phone) and desktop. At 50k-line/10 MB fixtures the
  assertions are "typing under budget" and "open scales linearly, no cliff" — not the 1 s gate.
  Justin's large personal note joins the fixtures (local, uncommitted). A loading affordance covers
  the streaming tail.
- Verify the cv stylesheet inside the real editor chrome on all three platforms early — nested
  scroll containers can change `content-visibility` behavior; the probe only proved a bare page.

- [T8 outcome (#105, done)](5-progressive-open/t8-outcome.md)
- [The one-paragraph note: measured, capped, then actually fixed (2026-09-01)](5-progressive-open/one-paragraph-note.md)
- [T9 outcome (#106, partial — one budget is MISSED)](5-progressive-open/t9-outcome.md)
- [Containment is OFF on Apple WebKit (2026-08-31, the outstanding iOS leg)](5-progressive-open/containment-off-on-apple-webkit.md)
- [Containment retired (2026-09-05)](5-progressive-open/containment-retired.md)
- [Gate run, real app, 2026-09-08 — every open under 1 s, one red left (first focus on the real note)](5-progressive-open/gate-run-2026-09-08.md)
