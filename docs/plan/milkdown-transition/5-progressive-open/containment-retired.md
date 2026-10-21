### Containment retired (2026-09-05)

The `content-visibility: auto` rule from T9 is gone, and `blockContainment.ts` with it. Measured on
the reference phone with `just test-android-perf-quick` (its Chrome 151 is the System WebView build)
against eager rendering installed BEFORE the load, so progressive open ran identically in both arms:

| Blocks (lines) | First focus, containment | First focus, eager | Focused keystroke sync / paint, containment → eager | Open complete, containment → eager |
|---|---|---|---|---|
| 500 (1k) | 3,017 ms | **176 ms** | — → 10 / 30 ms | 1,199 → 1,104 ms |
| 1,000 (2k) | 6,700–11,900 ms | **202 ms** | 28–31 / 76–94 ms → 12–22 / 51–86 ms | — → 1,391 ms |
| 2,000 (4k) | 47,700 ms | **379 ms** | — → 22–30 / 94–110 ms | — → 3,777 ms |
| 5,000 (10k) | not finishable | **810 ms** | — → 50–70 / 240–280 ms | 11,202 → 13,317 ms |

The stall is Chromium's editable-focus work meeting skipped blocks: one forced style+layout per
skipped block, so the first focus of a document is quadratic in its block count (the `pure-crepe`
spike characterized the trace; the spike doc was never merged). Ruled out by measurement: where the
caret sits at focus time, a DOM-only `focus()`, Google Autofill, accessibility services (none
enabled), and laying every block out once before the focus (17.5 s afterwards regardless). A
non-editable selection into the same DOM costs 34 ms, and a second focus of the same document
200–800 ms. Two windowed alternatives were measured and rejected: marking far blocks with a class
(ProseMirror re-parses any block whose attributes change — `registerMutation` treats it as a DOM
edit), and `:nth-child`-range rules (a 460 ms style recalc per window move at 5,000 blocks, scrolling
at ~1 s per frame). Eager rendering needs no engine gate, so the iOS/Chromium divergence from
2026-08-31 is gone too, and the drag ghost no longer has to shed a rule it inherited.

What replaces the containment probe in `just test-android-perf` is a first-focus budget:
`DEVICE_BUDGET.firstFocusMs` (1 s, the same as interactive) on the real-note-shaped fixtures,
measured by the shared snippet right after the open settles and before the keystroke loop.

**Gate run, real app, 2026-09-06** (`just test-android-perf`, everything above plus the scoped
preset passes and the document-identity load echo): 1k lines — interactive 178 ms, first focus
80 ms, keystroke p95 5.2 ms; 10k lines (blocks) — interactive 93 ms, first focus 640 ms, p95
5.7 ms; 10k lines with no blank line — first focus 1.6 s (measured, not gated), p95 12.5 ms;
25k lines with no blank line — p95 **31 ms, the one remaining red** (it was 1,586 ms on the
2026-09-02 run). The keystroke samples there sit at 11–16 ms with one 31 ms outlier over 8
samples, and `just test-android-perf-quick --fixture 25000-lines --profile` puts 92% of the CPU
in the WHOLE-DOCUMENT serialization the 200 ms change debounce runs after a typing pause —
~10 s on the main thread at 12,500 blocks, ~2 s at 5,000 — not in the keystroke itself. That
serialization (`getMarkdown()`, ProseMirror → mdast → remark-stringify) is the next perf item:
a per-block cache keyed on ProseMirror node identity would make it proportional to the edit,
but block serialization has context (adjacent-list marker alternation, list starts, the
blank-line `join`), so it needs the same equivalence census the chunked PARSE has
(`just chunk-census`) before it can land.
