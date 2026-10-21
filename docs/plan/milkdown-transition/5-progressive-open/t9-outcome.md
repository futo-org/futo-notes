### T9 outcome (#106, partial — one budget is MISSED)

`just test-android-perf` builds, installs and drives the REAL native Android app on a physical
low-end phone, measuring inside the editor WebView over CDP. The budget policy lives in
`tests/lib/editorDevicePerf.mjs` (unit-tested, `evaluateDeviceFloor`), the device glue in
`tests/android-editor-perf.mjs`. The keystroke loop is byte-for-byte the desktop gauntlet's
`measureKeystrokes`, so the two floors time the same unit.

Reference device: **moto g play (2023), Android 13, System WebView Chromium 151** — `$ANDROID_SERIAL`
selects it, and the recipe refuses to run without one rather than silently measuring a desktop-class
emulator.

| Fixture | Shape | Interactive | Complete | Keystroke p95 |
|---|---|---|---|---|
| 1,000 lines | real-note shaped | **185 ms** ✅ | 1.6 s | **17.5 ms** ❌ |
| 10,000 lines | real-note shaped | **126 ms** ✅ | 25.5 s | **64.0 ms** ❌ |
| 13,877 lines | the maintainer's real note | — | — | — (**cannot open**, see below) |
| 10,000 lines | no blank line anywhere | 15.3 s | 15.3 s | 544 ms |
| 25,000 lines | no blank line anywhere | 45.9 s | 45.9 s | 1,446 ms |

**Interactive-first-viewport passes with room to spare** — 185 ms and 126 ms against a 1,000 ms
budget, on the device D7 named as the hard case. That is progressive open (#105) doing exactly what
§5 predicted, and it is the headline result. (Interactive is not monotonic in document size because
the first chunk is a fixed ~80-line budget either way; the difference between those two numbers is
noise, not scaling.)

**Open scales linearly on the phone too — no cliff.** Per-line time-to-complete is 1.53 ms at 10k
lines and 1.84 ms at 25k, a ratio of **1.20x** against a 2.5x cliff factor. The TipTap-shaped wall
D3 was chosen to avoid does not appear on a low-end device either.

**Keystroke p95 misses the budget at EVERY real-note size** — 17.5 ms at 1,000 lines and 64.0 ms at
10,000, against 16 ms. The 1,000-line number is the one that matters: §2's population study puts
every note in the maintainer's vault except one at ≤978 lines, so this is not a tail case, it is the
ordinary large note. It is a real miss against the acceptance criterion and it is **not** fixed here.

Two things are worth recording about how that number was obtained, because the first version of this
work reported 10.5 ms and passed. It was measuring the wrong document: the runner pushed its first
fixture before the shell's own `FutoEditor.initialize` had landed, the host then overwrote it with
the seeded one-line note, and a stale `futo:editor-open-complete` measure made the wait return
immediately — so the first fixture of every run reported the numbers of a 1-line note. The tell was
visible in the output and was missed: interactive exactly equal to complete, a signature no chunkable
fixture can produce. The runner now waits on the host's own load and then VERIFIES that the document
on screen is the fixture it asked for, which is the guard that turned the false pass red.

What was ruled out as the cause of the keystroke cost: our own decoration plugins, which
`blockDecorations.ts` already bounds to the transaction's changed ranges. Two attribution attempts
failed and are written down so the next person does not repeat them — a device CPU profile was
dominated by ONE 200 ms-debounced whole-doc serialization (background work, not keystroke work), and
a per-plugin `reconfigure` ablation had a ±25 ms noise floor, larger than most per-plugin effects.
Attribution needs a sourcemapped bundle or a plugin-by-plugin build, which is its own ticket.

**The 50k rung §5 quotes is opt-in (`--stress`), and that is a cost decision.** On the reference
phone a 50k unchunkable document did not finish its leg inside 20 minutes: the open is a whole-
document parse and each settled-to-paint keystroke sample costs tens of seconds at that size, with
the renderer at 560 MB on a 2.8 GB device. The default ladder proves the same no-cliff property on
the 10k→25k ratio — the check is a ratio, so the rungs are interchangeable — and `--stress` adds 50k
for anyone who wants §5's exact number. A default run costs ~25 minutes on the reference phone.

**The fixture shape turned out to be load-bearing, and the first version of this work got it wrong.**
The desktop floor's `lineFixture` has no blank line anywhere, so `planMarkdownChunks` declines it
(`no-boundary`) and it loads whole — 15.3 s on this phone. Holding it to a 1 s
interactive-first-viewport budget asks progressive open for something it structurally cannot deliver,
and §5 already says those notes "open no worse than they do today". The device ladder therefore has
two generators, differing in exactly one property (block separation): `blockFixture` carries the
interactive budget, `lineFixture` carries the scaling/cliff assertion. Both facts are asserted in
`editorDevicePerf.test.mjs` so the reasoning cannot rot into a comment nobody trusts.

**The maintainer's real note still cannot be opened at all** — the local uncommitted fixture
(13,877 lines) fails with #101's `Cannot close 'paragraph': a different token ('wikilink') is open`,
the same crash §5's census recorded for any note whose line ends in `!`. The runner scores this as a
`load-failure` violation and exits red rather than reporting "every budget held" over a document that
never loaded (M11). So the criterion "budgets proven on the maintainer's largest real note" is
**blocked on #101**, not on anything here.

**Containment verified in the real editor chrome on Android and desktop, NOT on iOS.** The rule
(`.ProseMirror > *`, `content-visibility: auto` + `contain-intrinsic-size: auto 24px`) lives in
`MilkdownEditor.svelte`, and both probes assert the same three things: the computed style is live,
the caret can be driven into a rendering-skipped region, and the block it lands in is REAL rendered
content rather than a `contain-intrinsic-size` estimate.

- **Desktop** (`tests/editor-embed-milkdown.spec.ts`, chromium over the shipped `editor.html`) —
  passes, and red-proved by deleting the rule.
- **Android** (the phone, inside the real Compose chrome) — passes. Two facts the bare-page probe
  could not have given: the scroll container really is `.ProseMirror` itself (clientHeight 742,
  scrollHeight 184,209 over 5,000 top-level blocks), so the shell's chrome introduces no competing
  scroll container; and the caret's block renders at its true 27 px rather than the 24 px estimate.
- **iOS** — covered on 2026-08-31, and the answer is that the rule cannot run there. See below.
