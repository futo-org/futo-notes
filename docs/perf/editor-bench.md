# Editor hill-climb bench — 2026-10-09

`just bench-editor` (`scripts/perf/editor-bench.mjs`) runs six editor interactions in
headless Chromium against the shipped `editor.html` and scores them by how much work the
browser does, not by milliseconds. On Chromium a keystroke's cost is the renderer's style
and layout, not editor JS (`keystroke-attribution.md`), and wall-clock time on a shared
machine is too noisy to judge a 3 % change. The counts repeat within 0.1 % on a quiet machine
and 0.22 % with 28 of 32 cores pinned busy; `--check` fails above 0.5 %.

Each scenario waits until the editor is idle (four full 50 ms idle periods in a row) before
and after its measured step. The open primes the serializer and streams its tail in idle
slices sized by wall time; without the wait, switch-note's JS calls moved 17 % between two
passes, depending on how much of the previous open was still running.

## What it counts

- `styledElements`: elements whose style the browser recomputed (`UpdateLayoutTree.elementCount`).
- `layoutScope`: objects under the root of each layout pass (`Layout.totalObjects`). The root
  is `#document` for every keystroke today, so this is "layouts × note size".
- `jsCalls`: every JS function invocation (V8 precise coverage), the closest thing to an
  instruction count.

Each scenario's final markdown is hashed. `--baseline` fails the run if a hash changes.

## Baseline (rebased onto !402 `5e218fedc`, jfedora)

| Scenario                           | styledElements | layoutScope | jsCalls    | measured wall (median of 5) |
| ---------------------------------- | -------------- | ----------- | ---------- | --------------------------- |
| open-large (2000 blocks)           | 29,245         | 202,667     | 16,419,562 | 382 ms ±10 %                |
| switch-note (→ 400 blocks)         | 5,568          | 12,883      | 2,475,497  | 80 ms ±2 %                  |
| type-small (40 blocks, 10 keys)    | 0              | 5,520       | 42,825     | 361 ms (frame-bound)        |
| type-large (2000 blocks, 10 keys)  | 0              | 272,080     | 648,385    | 374 ms (frame-bound)        |
| enter-list-large (Enter+2 keys ×3) | 102            | 326,622     | 590,396    | 373 ms (frame-bound)        |
| backspace-join-large (6 keys)      | 9              | 163,230     | 406,848    | 312 ms (frame-bound)        |

Raw numbers: `editor-bench-baseline.json`. Wall times are from the pre-rebase run (the
rebased run's were ±100 %+ under other load on the machine). Typing scenarios' wall time is
mostly the 16.7 ms frame wait per key; their `layoutMs`/`scriptMs` columns are ±15–60 % even
when quiet. Use them for feel, never to decide.

Rebasing onto !402 moved nothing: every count is within 0.1 % of the pre-rebase bundle and
every hash matches (score 0.9999). !402 is block-drag code, and no scenario drags yet.

Two hills fall out of the baseline: a keystroke in a 2000-block note lays out ~27k objects
against ~550 in a 40-block note (49×), and makes ~65k JS calls against ~4.3k (15×). Both
should be close to flat in note length.

## Suite speed

| Mode                                             | Wall                                  |
| ------------------------------------------------ | ------------------------------------- |
| `--runs 0` (build + counts): the hill-climb loop | 7.3–7.6 s (build 4.8 s, counts 2.5 s) |
| `--no-build --runs 0`                            | 2.2 s                                 |
| `--runs 5 --check` (full report)                 | 46–56 s (timing passes 41–47 s)       |

The count pass runs all six scenarios in parallel, one browser each. A scenario run is
~170 ms page load, ~750 ms untimed setup (opening the large note, then the idle wait),
~370 ms measured, ~200 ms trailing idle wait.
`vite build --watch` rebuilds in ~2.6 s after a one-file edit, against 4.6 s cold; not
wired in.

## Sensitivity check

The editor already sets `contain: layout style` on every block, so adding it changed
nothing (score 1.0001). `content-visibility: auto` on top-level blocks moved the score to
0.6063: `layoutScope` −74 to −92 % in every scenario, `styledElements` −86 % on open. Not
landed: it touches scroll anchoring, find, block-drag geometry and the Chromium 80 WebView
floor, none of which the markdown hash checks.

## Traps

- `--no-build` measures whatever `build/native-editor/editor.html` holds. After any source
  edit, build — a stale probe bundle scored 0.6063 against clean source.
- The hash only guards the markdown. A climb also needs the `editor-embed` Playwright suite
  green, since scroll, caret and drag regressions do not change the markdown.
- It runs under `node --experimental-strip-types` because it imports the fake host from
  `tests/lib/editorEmbedHost.ts`. `tsx` breaks it: esbuild adds a `__name` helper to the
  init script Playwright serializes into the page, and the host never installs.
- Headless Chromium is the Android WebView's engine, not iOS WebKit or WebKitGTK. Confirm a
  win on a device before calling it one.
