# Editor hill-climb bench — 2026-10-09

`just bench-editor` (`scripts/perf/editor-bench.mjs`) runs eight editor interactions in
headless Chromium against the shipped `editor.html` and scores them by how much work the
browser does, not by milliseconds. On Chromium a keystroke's cost is the renderer's style
and layout, not editor JS (`keystroke-attribution.md`), and wall-clock time on a shared
machine is too noisy to judge a 3 % change. The counts repeat within 0.15 % on a quiet
machine; `--check` fails a drift past both 0.5 % and 24.

Each scenario waits until the editor is idle (four full 50 ms idle periods in a row) before
and after its measured step. The open primes the serializer and streams its tail in idle
slices sized by wall time; without the wait, switch-note's JS calls moved 17 % between two
passes, depending on how much of the previous open was still running.

To climb it, follow `editor-bench-climb.md`; `just bench-climb-gate` judges each candidate,
and `just bench-editor --no-build --why <scenario>` names what caused each big restyle and layout.

## What it counts

- `styledElements`: elements whose style the browser recomputed (`UpdateLayoutTree.elementCount`).
- `layoutScope`: objects under the root of each layout pass (`Layout.totalObjects`). The root
  is `#document` for every keystroke today, so this is "layouts × note size".
- `jsCalls`: every JS function invocation (V8 precise coverage), the closest thing to an
  instruction count.

Each scenario's final markdown is hashed. `--baseline` fails the run if a hash changes.

## Baseline (rebased onto !402 `5e218fedc`, jfedora)

| Scenario                                    | styledElements | layoutScope | jsCalls    |
| ------------------------------------------- | -------------- | ----------- | ---------- |
| open-large (2000 blocks)                    | 29,247         | 202,667     | 16,419,564 |
| switch-note (→ 400 blocks)                  | 5,569          | 12,883      | 2,475,512  |
| type-small (40 blocks, 10 keys)             | 0              | 5,520       | 42,837     |
| type-large (2000 blocks, 10 keys)           | 0              | 272,080     | 648,371    |
| enter-list-large (Enter+2 keys ×3)          | 102            | 326,622     | 590,386    |
| backspace-join-large (6 keys)               | 9              | 163,230     | 406,845    |
| drag-small (40 blocks, block 1 → below 7)   | 465            | 2,104       | 15,160     |
| drag-large (2000 blocks, block 1 → below 7) | 7,513          | 82,072      | 339,752    |

Raw numbers, with wall-clock columns: `editor-bench-baseline.json` (median of 3 count passes,
5 timing runs). Its wall times were taken at load average 7–24 from other work and swing up
to ±160 %; on a quiet machine typing scenarios measure ~360–390 ms, almost all of it the
16.7 ms frame wait per key. Use milliseconds for feel, never to decide.

Rebasing onto !402 moved none of the first six scenarios: every count within 0.1 % of the
pre-rebase bundle, every hash the same (score 0.9999).

## Hills the baseline shows

- **Typing scales with note length.** A keystroke in a 2000-block note lays out ~27k objects
  against ~550 in a 40-block note (49×) and makes ~65k JS calls against ~4.3k (15×).
- **A drop restyles the whole note, twice.** In drag-large, the two frames after `pointerup`
  restyle 3,611 and 3,601 elements: 96 % of the scenario's restyling, against 465 for the
  whole drag-small. The lift (at the 340 ms hold) runs two layouts over all 27,229 objects,
  and the drop a third. Compare the Android real-app drop freeze of 0.9–2.7 s.

## The drag scenarios

The long-press drag both native shells ship (`mobileBlockDnd.ts`), driven by a CDP touch
stream as the editor-embed spec does. The hold ends on the editor's own `haptic` post, not a
sleep; then 12 moves, one per frame, a release, and the drop's `change`. No autoscroll: its
speed is time-based.

Two things in it are sampled by wall time, so the bench pins them down:

- CSS transitions run 100× fast (`Animation.setPlaybackRate`), so the slides cost the
  elements they touch rather than however many frames the machine rendered. Without it the
  drag counts flipped by a whole slide frame (~50 elements) between passes under load. The
  drop lands where it did at normal speed: the hashes match.
- The 340 ms hold still spans 20 or 21 frames of a 4–5-element animation, so drag-small
  wanders by up to ~12 elements. That is what the 24-element slack in `--check` is for.

With 28 of 32 cores pinned busy, a drag pass can also catch one extra layout (drag-small
`layoutScope` +10 %, once in three runs). `--passes 3` scores each count's median; under
that load the 3-pass score held at 1.0000–1.0002.

After the drop, Chromium hands out no idle callbacks for ~1.8 s although the trace shows
~10 ms of work in that window. The trailing idle wait sits through it, which is what makes
a drag scenario ~4.7 s end to end.

## Suite speed (quiet machine)

| Mode                                               | Wall                                  |
| -------------------------------------------------- | ------------------------------------- |
| `--runs 0`: build + one count pass, the climb loop | 9.5–9.8 s (build 4.6 s, counts 4.8 s) |
| `--runs 0 --passes 3`: confirm a win               | 19 s                                  |
| `--no-build --runs 0`                              | 4.9 s                                 |
| `--runs 5 --passes 3 --check` (full report)        | ~110 s                                |

The count pass runs all eight scenarios in parallel, one browser each, so it lasts as long
as drag-large: ~0.2 s page load, ~1.4 s setup, ~1.2 s measured gesture, ~1.9 s idle wait.
Without the drags a pass is 2.5 s. `vite build --watch` rebuilds in ~2.6 s after a one-file
edit, against 4.6 s cold; not wired in.

## Sensitivity check

The editor already sets `contain: layout style` on every block, so adding it changed
nothing (score 1.0001). `content-visibility: auto` on top-level blocks moved the score to
0.6063 (before the drag scenarios existed): `layoutScope` −74 to −92 % in every scenario,
`styledElements` −86 % on open. Not landed: it touches scroll anchoring, find, block-drag
geometry and the Chromium 80 WebView floor, none of which the markdown hash checks.

## Traps

- `--no-build` measures whatever `build/native-editor/editor.html` holds. After any source
  edit, build — a stale probe bundle scored 0.6063 against clean source.
- The hash only guards the markdown. A climb also needs the `editor-embed` Playwright suite
  green, since scroll, caret and drag regressions do not change the markdown.
- Accept a win only from `--passes 3`; a single pass under load can be one extra event off.
- It runs under `node --experimental-strip-types` because it imports the fake host from
  `tests/lib/editorEmbedHost.ts`. `tsx` breaks it: esbuild adds a `__name` helper to the
  init script Playwright serializes into the page, and the host never installs.
- Headless Chromium is the Android WebView's engine, not iOS WebKit or WebKitGTK. Confirm a
  win on a device before calling it one.
