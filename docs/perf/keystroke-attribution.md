# Keystroke attribution and the typing tripwire

Measured 2026-10-08 on an Android emulator, for issue #113 (keystroke p95 over
budget on the reference moto g play). **This doc does not settle #113.** The
emulator runs on a desktop CPU, where a keystroke's JavaScript takes under 1 ms
against a 16 ms budget. It shows the *shape* of a keystroke's cost, not whether
that cost fits a frame on the phone. The verdict needs the same two commands run
on the moto g.

## What exists now

- **The interaction ledger** (`src/shared/perf/interactionLedger.ts`). One
  always-on timeline for four kinds of interaction: `note-switch`, `note-open`,
  `block-drag` and `keystroke`. Each mark costs one `performance.now()` and one
  array write. Each kind keeps its last 100 records, so a typing run never pushes
  out the note switch the tab-switch probe reads. `noteSwitchTimeline.ts` is now
  a thin wrapper over it, with the same phase names and the same
  `__notesShellTest.noteSwitchTimelines()` reader that
  `scripts/perf/tab-switch-probe.js` uses. Readable through `__perfCourse`
  (desktop dev/test builds) and `__futoTest` (the native embed's `?test` URL).
  - `note-open`: `interactive`, `complete` (the same two moments as the
    `futo:editor-open-*` performance measures).
  - `block-drag`: `lifted`, then `released` + `dropped`, or `cancelled`.
- **The keystroke tripwire.** Off unless a test harness turns it on. When on,
  the first edit in each frame opens a `keystroke` record and the next animation
  frame closes it, so each sample is dispatch → next frame, the number the device
  runners call "settled". Edits that share a frame record nothing extra. It is
  turned on by `installPerfCourse` (desktop, behind `TEST_HOOKS_ENABLED`) and by
  the embed's `?test` URL, which only a debug Android build loads. A release
  build pays one boolean read per edit.
- **Attribution tooling.** `tests/android-editor-attribution.mjs` builds
  `editor.html` with an inline source map into `build/native-editor-attribution/`,
  stages it into the native assets, installs the debug app, opens a seeded note,
  runs the device gate's own keystroke loop under a CDP CPU profile
  (`Profiler.start` / `Profiler.stop`), and maps every sampled frame back to a
  repo file or npm package (`tests/lib/profileAttribution.mjs`). It restores the
  plain bundle afterwards, including when the app fails to launch, so the
  sourcemapped bundle never outlives the run. It also saves each raw
  `.cpuprofile` for the DevTools Performance panel.

## Method

```sh
export ANDROID_SERIAL=<device>
# Tripwire cost: the same bundle with the tripwire on (default) and off.
just test-android-perf-quick --no-build --fixture 1000-lines-blocks --fixture 10000-lines-blocks --samples 40
just test-android-perf-quick --no-build --no-tripwire --fixture 1000-lines-blocks --fixture 10000-lines-blocks --samples 40
# Attribution, in the real dev app:
node tests/android-editor-attribution.mjs --fixture 1000-lines-blocks --fixture 10000-lines-blocks --top 10 --samples 40
```

The quick runner now always loads `editor.html?test`. Its measurement snippet
has read `window.__futoTest` since c10fb812d, and that object only exists under
`?test`, so before this change every quick run died in the page with
`TypeError: Cannot read properties of undefined (reading 'documentRef')`.

**Device:** AVD `futo-hc-typing` (Android 16, `sdk_gphone64_x86_64`, Chrome
133.0.6943.137), on a 32-core host shared with other emulator lanes.

## Tripwire cost: unchanged within noise

Three bundles, interleaved before/off/on per rep, 6 reps, 40 keystrokes each:

- **before**: the base commit 13021342d, which has no ledger.
- **off**: this branch with the tripwire switched off, which is what a release build runs.
- **on**: this branch with the tripwire recording, which is what a dev or test build runs.

| fixture | build | keystroke p95, median of runs (ms) | p90 of runs (ms) | pooled p95 (ms) | settled p95 (ms) | tripwire p95 (ms) |
|---|---|---:|---:|---:|---:|---:|
| 1000-lines-blocks | before | 0.65 | 0.80 | 0.80 | 16.8 | n/a |
| 1000-lines-blocks | off | 0.70 | 0.80 | 0.70 | 16.8 | n/a |
| 1000-lines-blocks | on | 0.70 | 0.90 | 0.80 | 16.8 | 16.7 |
| 10000-lines-blocks | before | 0.70 | 0.80 | 0.70 | 16.9 | n/a |
| 10000-lines-blocks | off | 0.70 | 0.90 | 0.80 | 16.9 | n/a |
| 10000-lines-blocks | on | 0.65 | 0.80 | 0.70 | 16.9 | 16.7 |

"Keystroke p95" is the synchronous dispatch time the device gate budgets at
16 ms. Every difference is one step of the page clock's 0.1 ms resolution, and
the differences point both ways. Host load average was 29 to 49 during the runs.

The tripwire's own readout agrees with the runner's independent "settled"
measurement to within 0.2 ms on both fixtures. So the tripwire records the
number it claims to.

## Attribution on the emulator

One attribution run, 40 keystrokes per fixture, sampling every 200 µs. Host load
average was 53 to 65. "Busy" is the profile minus V8's `(idle)` samples.
`(program)` is the renderer's own non-JavaScript work: style recalc, layout,
paint and parse.

| fixture | busy CPU per 40 keystrokes | browser-native share | editor JS per keystroke | settled p95 |
|---|---:|---:|---:|---:|
| 1000-lines-blocks | 114 ms | 81% | about 0.5 ms | 17.1 ms |
| 10000-lines-blocks | 558 ms | 96% | about 0.6 ms | 20.4 ms |

Top 10 self-time functions on **10000-lines-blocks**:

| self ms | share | function |
|---:|---:|---|
| 534.7 | 96% | (program), browser-native |
| 5.3 | 1% | updateBlockChildren, node_modules/prosemirror-view/dist/index.js:1509 |
| 2.6 | 0% | (anonymous), no script, unmapped JS |
| 1.8 | 0% | get nodeSize, node_modules/prosemirror-model/dist/index.js:1195 |
| 0.9 | 0% | g, node_modules/lodash-es/debounce.js:125 |
| 0.9 | 0% | replaceRange, node_modules/prosemirror-transform/dist/index.js:1650 |
| 0.8 | 0% | iterDeco, node_modules/prosemirror-view/dist/index.js:2119 |
| 0.8 | 0% | nodesBetween, node_modules/prosemirror-model/dist/index.js:95 |
| 0.6 | 0% | closeKeystrokeFrame, src/shared/perf/interactionLedger.ts:113 |
| 0.5 | 0% | notify, src/features/editor/milkdown/find/findPlugin.ts:313 |

Top 10 self-time functions on **1000-lines-blocks**:

| self ms | share | function |
|---:|---:|---|
| 92.3 | 81% | (program), browser-native |
| 1.8 | 2% | updateBlockChildren, node_modules/prosemirror-view/dist/index.js:1509 |
| 1.3 | 1% | applyTransaction, node_modules/prosemirror-state/dist/index.js:793 |
| 1.3 | 1% | closeKeystrokeFrame, src/shared/perf/interactionLedger.ts:113 |
| 0.6 | 0% | nodesBetween, node_modules/prosemirror-model/dist/index.js:95 |
| 0.5 | 0% | emitFormatState, src/features/editor/milkdown/MilkdownEditor.svelte:388 |
| 0.5 | 0% | requestAnimationFrame, no script, unmapped JS |
| 0.5 | 0% | applyInner, node_modules/prosemirror-state/dist/index.js:830 |
| 0.5 | 0% | inTable, packages/editor/src/milkdown-compat/tablePasses.ts:39 |
| 0.3 | 0% | readOpenRun, src/features/editor/milkdown/wikilink/autocomplete.ts:65 |

**What this suggests for #113, unconfirmed on the phone:** the keystroke's
JavaScript stays flat as the note grows. On the emulator it is about half a
millisecond at both 1,000 and 10,000 lines. The browser's own work after the
edit grows with the note: about 2.3 ms per keystroke at 1,000 lines and about
13 ms at 10,000. That is where the 10,000-line settled p95 goes past one frame.
If the moto g shows the same split, the next lever is the style and layout scope
of an edit, not the editor's JavaScript.

## Caveats

- **Not the reference phone.** Everything here is from an x86 emulator on a
  loaded desktop host. Absolute numbers do not transfer to the moto g. The #113
  verdict needs both commands above run there.
- **The CPU profile cannot split `(program)`.** It does not say whether the
  native time is style, layout or paint. A `Tracing` capture with the
  `devtools.timeline` category would split it. This run did not take one.
- **Default typing mode.** The loop dispatches transactions without focusing the
  editor, as the device gate does. `--focused` in the quick runner adds the
  native selection and IME work. That mode was not profiled.
- **One attribution run.** Shares are stable enough to rank the buckets, but the
  sub-millisecond JS rows move between runs at a 200 µs sampling interval.
- **The tripwire's on-cost.** `closeKeystrokeFrame` shows up at about 1% of busy
  time with the tripwire on. That cost exists only in dev and test builds. The
  release path is the "off" row above.
- **Host contention.** Other lanes ran emulators and builds throughout. The
  emulator's adb shell wedged once at 99% disk use and had to be cold-booted.
  Before/after reps were interleaved so contention hits all three bundles alike.
