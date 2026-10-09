# Climbing the editor bench — the brief

Read this whole file before the first edit. It is the entire protocol for "hill climb the
editor bench"; `editor-bench.md` explains the bench itself.

## The loop

1. Pick one idea from the hills below, or from the bench's own output.
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
pass. Do not run anything else heavy while the bench runs; it shares the machine.

## Hills (from the baseline)

- **The drop restyles the whole note, twice.** drag-large: the two frames after `pointerup`
  restyle 3,611 and 3,601 elements, 96 % of the scenario's restyling. Start in
  `mobileBlockDnd.ts` (`ARMED_CLASS`, `HIDE_SELECTION_CLASS`: a class on the editor root
  whose descendant rules restyle every block) and `blockDragSession.ts`.
- **The lift lays out the whole note, twice.** drag-large: two layouts over all 27,229
  objects at the 340 ms mark.
- **Typing scales with note length.** A keystroke in 2000 blocks lays out ~27k objects
  (vs ~550 in 40 blocks) and makes ~65k JS calls (vs ~4.3k). Find what walks the whole
  document per transaction (decorations, plugins' `view.update`, serializer).

To see where a scenario's work lands, `just bench-editor --no-build --runs 0 --only <scenario>`
with a Chromium trace is the tool; the per-frame breakdown in `editor-bench.md` shows how.

## Not yours to decide — stop and report instead

- `content-visibility` / skipping offscreen rendering: it moved the score 40 % and is a
  product decision (scroll anchoring, find, drag geometry, the Chromium 80 WebView floor).
- Anything that changes what the editor saves, the bridge messages, or a spec'd behavior
  (`docs/spec/editor.md`). The gate catches a lot of this; not all.
- Rules AGENTS.md marks CRITICAL, and a hot-path note rule (those have a Rust twin and
  conformance goldens: `packages/editor/AGENTS.md`).

## What a gate ACCEPT does not prove

Headless Chromium is the Android WebView's engine, not iOS WebKit or WebKitGTK, and not a
phone. A landed climb is a candidate until it is measured on a device.

## Ideas log

| Idea | Result | Why |
| ---- | ------ | --- |
