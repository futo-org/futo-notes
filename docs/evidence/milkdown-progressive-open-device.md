# Is progressive open load-bearing on the reference phone?

> **Note (2026-09-05):** the `content-visibility` containment rule this compares against was
> retired (docs/plan/milkdown-transition.md §5 "Containment retired"); every block now renders
> eagerly, and the containment probe is gone from the gate. The conclusion stands — progressive
> open is still what makes the first viewport interactive under 1 s.

**Yes.** Disabling it and relying on the `content-visibility` containment rule
alone misses the 1s time-to-interactive-first-viewport budget at every
real-note-shaped size measured. Keep `markdownChunks.ts`, `progressiveLoad.ts`
and the save lock.

Measured 2026-09-02 on the low-end reference phone — moto g play (2023),
Android 13, `ZY22HSGXSG` — via `just test-android-perf`, twice, changing
exactly one line between runs: `DEFAULT_CHUNK_OPTIONS.minLines` in
`src/features/editor/milkdown/markdownChunks.ts`, `400` (production) versus
`Number.POSITIVE_INFINITY` (every document loads whole). `content-visibility:
auto` was active in both runs; the containment probe confirms it.

## Time-to-interactive-first-viewport (budget: 1000ms)

| Fixture | Progressive open | Containment only | Ratio |
|---|---|---|---|
| `1000-lines-blocks` | **213ms** PASS | 1148ms FAIL | 5.4× |
| `10000-lines-blocks` | **109ms** PASS | 7997ms FAIL | 73× |
| `10000-lines` (unchunkable) | 17735ms | 18961ms | 1.07× |
| `25000-lines` (unchunkable) | 44508ms | 44145ms | 0.99× |

The `*-blocks` fixtures are real-note shaped — a blank line between blocks — so
`planMarkdownChunks` cuts them, and they are the ones the budget is written
for. The `*-lines` fixtures have no blank line anywhere, so progressive open
declines them in BOTH runs; their numbers matching within noise is the
control. It says the difference above is chunking and nothing else.

## Keystroke p95 (budget: 16ms)

| Fixture | Progressive open | Containment only |
|---|---|---|
| `1000-lines-blocks` | 12.2ms PASS | 10.2ms PASS |
| `10000-lines-blocks` | 31.8ms FAIL | 70.6ms FAIL |
| `10000-lines` | 563.8ms FAIL | 643.5ms FAIL |
| `25000-lines` | 1586.1ms FAIL | 1539.8ms FAIL |

Keystroke p95 misses in both configurations, so that miss is not about
progressive open — it is the tracked keystroke-p95 issue, independent of this
question. Chunking does help it at 10k blocks (32ms against 71ms), it just
does not close it.

## Why this was worth measuring

The desktop probe had cleared the open budget on the containment rule alone
(852ms at 14k lines), which made ~950 lines of chunking machinery look like
they might be desktop-driven complexity. They are not: the same rule on the
reference phone gives 1148ms at 1,000 lines. Nothing in the repo had measured
the phone with chunking off, so the question was open until now.

Both runs also report `PARTIAL`: no real-note fixture was present
(`$FUTO_PERF_NOTE` / `tests/editor-gauntlet/local/device-perf-note.md`), so the
synthetic ladder carried the result. A real-note run would add a data point,
not change the verdict — the 1,000-line rung already fails without chunking,
and every real note in the plan's size population is larger than that.
