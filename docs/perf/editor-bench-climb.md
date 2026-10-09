# Climbing the editor bench — the brief

Read this whole file before the first edit. It is the entire protocol for "hill climb the
editor bench"; `editor-bench.md` explains the bench itself.

## The loop

1. Pick one idea from the hills below. Before editing, run
   `just bench-editor --no-build --why <scenario>`: for every restyle of 100+ elements and
   every layout over 1000+ objects it prints what invalidated it and the JS stack that did
   (~10 s, on an unminified build). Fix the cause it names, not a guess.
2. Edit. Iterate fast with `just bench-editor --runs 0 --baseline docs/perf/editor-bench-baseline.json`
   (~10 s, one count pass). Always without `--no-build`: it scores whatever bundle is on
   disk, not your edit.
3. When it looks like a win, run the gate: `just bench-climb-gate --accept`. It rebuilds,
   runs 3 count passes, and if the score improved with no count worse, runs the ~700-test
   editor-embed suite (~1.5 min). It prints ACCEPT or REJECT and why, and only on ACCEPT
   rewrites the baseline.
4. ACCEPT: one commit holding the change and the new `docs/perf/editor-bench-baseline.json`.
   The message names the before → after counts from the gate and a
   `Verified: just bench-climb-gate` line. Tests the gate reports as flaky under load go in
   the commit body. REJECT: revert the edit (`git checkout -- <files>` for your own files
   only) and log the idea below with the reason.
5. Stop after 5 REJECTs in a row, or when the remaining ideas each need a decision listed
   under "Not yours to decide". Report what landed and the ideas log.

Never edit the baseline, the bench, the gate or its known-failures file to make a change
pass. `jsCalls` counts function calls, not work: merging or inlining functions to lower it is
not a win. A change whose gain is mostly `jsCalls` must say in the commit what work it removed
(a walk, a re-render, a serialization); if it removed none, revert it. Do not run anything else heavy while the bench runs; it shares the machine.

## Hills (from the baseline, causes from `--why`)

- **The drop restyles the whole note, twice.** drag-large: 3,611 then 3,601 elements, 96 %
  of the scenario's restyling. Both are an inline-style write on the editor root:
  `holdScrollThroughDrop` (`blockDragCurtain.ts`) sets `overflow-anchor: none` on it, and a
  `requestAnimationFrame` two frames later removes it.
- **The lift lays out the whole note, twice.** drag-large: two layouts over all 27,229
  objects at the 340 ms mark, both forced inside `createGhost` (`blockDragSession.ts`):
  `drawGhostShadow` after the ghost goes in, then again after its canvas does.
- **Every keystroke lays out the whole note.** type-large: 10 keys, 10 layouts over 27,208
  objects with 10 dirty, caused by the browser's own text change. Nothing in the note is a
  relayout boundary, so the root is `#document`. Also ~65k JS calls per key against ~4.3k
  in 40 blocks: something walks the document per transaction (decorations, a plugin's
  `view.update`, the serializer).

## Confirm on the phone

The reference phone is the moto g play 2023, `ZY22HSGXSG` (`adb devices -l`; never the
Pixel 7a, which is personal). After every ACCEPT, measure the interaction you changed there
and put before → after in the commit body:

- Typing or opening: `ANDROID_SERIAL=ZY22HSGXSG just test-android-perf-quick --fixture 1000-lines-blocks`
  (~1 min; the phone's Chrome is the same Chromium build as its WebView). Baseline
  2026-10-09: interactive 164 ms, first focus 295 ms, keystroke p95 5.8 ms (settled 31.7 ms).
- Drag: `ANDROID_SERIAL=ZY22HSGXSG just bench-block-drag current --device android --sizes 1000`
  (~2 min). Baseline 2026-10-09: lift frame 82.7 ms, drop 35.1 ms, gap frame p95 18.0 ms.

A gate ACCEPT that does not move the phone is still worth keeping if nothing got slower, but
say so in the commit; do not claim a user-visible win the phone did not show.

## Not yours to decide — stop and report instead

- `content-visibility` / skipping offscreen rendering: it moved the score 40 % and is a
  product decision (scroll anchoring, find, drag geometry, the Chromium 80 WebView floor).
- Anything that changes what the editor saves, the bridge messages, or a spec'd behavior
  (`docs/spec/editor.md`). The gate catches a lot of this; not all.
- Rules AGENTS.md marks CRITICAL, and a hot-path note rule (those have a Rust twin and
  conformance goldens: `packages/editor/AGENTS.md`).

## What a gate ACCEPT does not prove

Headless Chromium is the Android WebView's engine, not iOS WebKit or WebKitGTK. The phone
step covers Android; iOS and desktop are unmeasured, so say that in the final report.

## Ideas log

| Idea | Result | Why |
| ---- | ------ | --- |
