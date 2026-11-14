# Native editor real-input measurements

`ANDROID_SERIAL=<claimed Moto> just test-android-real-input` builds and installs an
R8-optimized, non-debuggable **dev** app and measures real keyboard typing and
animated note open/close. The dev package and DEVICE-mode vault remain isolated
from production. Each run creates a unique fixture folder and retains it.

Evidence lives under `.futo/runs/android-real-input-<id>/`: the tested APK and hash,
tracked source patch, source/dirty state, dexopt state, plans, input receipts,
latency logs, frame traces, import health, and report. The APK is the exact tested
artifact; a tracked patch does not contain untracked source files.

`--reuse` verifies the installed APK against this checkout's built APK, not against
current source. Rebuild after edits. `--only paragraph`, `--only typing`, and
`--only navigation` select stories. Navigation defaults to three cycles;
`--cycles 1` measures one open/close of each fixture. `--unoptimized` explicitly
selects an unoptimized debug control; the runner verifies the R8 marker in the APK.

`--fixture /path/to/original-note.md --find-cell 'unique cell text'` instead measures
one whole corpus note through its real table-cell field and Gboard. Find reaches
the cell through the app UI; the runner refuses a missing native cell. The typing
plan includes deletion but no Enter, so it stays in that cell. This mode retains
the original fixture in its evidence and uses a new isolated test folder, like the
built-in stories. It does not measure navigation.

Requirements: a claimed Moto g play (2023), Android SDK 36 platform and build-tools,
javac, unzip, and Perfetto trace_processor_shell (`PERFETTO_TRACE_PROCESSOR` or its
usual user cache). The supported 720×1600 keyboard maps were visually checked for
FUTO Keyboard and Gboard at normal font scale. Other layouts are refused.

## Measurements and scope

One shell Java process injects touch down/up through Android's input dispatcher.
The keyboard, input connection, Rust engine, and native view run normally. Touches
are 150–310 ms apart, held for 35 ms, with a 1.8 s thinking pause. There is no CPU
pinning, fixed clock, editor priority override, direct text injection, accessibility
service, or instrumentation runner. The app must report zero WebViews, and its
actual view hierarchy must contain TextFirstEditText.

Three fixtures cover multi-paragraph prose, an 80-task checklist, and an 8 KB
paragraph. Each receives 150 touches including deletion; ordinary notes also get
Enter. Long-paragraph typing deliberately does not split the paragraph. Saved text
is checked. Navigation uses actual row and Back touches with the normal animation.

Lightweight Perfetto records FrameTimeline plus process metadata. The report
retains presented frames, app-deadline misses, explicitly dropped frames, and
keyboard frames. Keyboard frames are diagnostic only. Dropped app frames are kept
even if they have no matching SurfaceFlinger presentation record.

Native timing starts when an input operation reaches the editor and ends at the
end of onDraw. It excludes keyboard processing, RenderThread/GPU work, and panel
latency. In table-cell mode this is the note view’s onDraw; the cell overlay
may draw afterward. FrameTimeline observes the whole app window separately.
`workP95` sums elapsed editor, view-update, and draw stages, excluding UI
queue and refresh waiting; it is not a CPU-time measurement or a frame deadline.
Windows contain up to 50 drawn updates; idle and close flush the partial tail.
First/final input coverage is checked. No-op keyboard operations need not draw.
The Java receipt's final timestamp is completion of UP injection, not UP's original
event timestamp. There is no per-key input-to-compositor correlation yet. Only the final pending
update per draw is timed; coalesced updates are not individually reconstructed.
First/final coverage checks do not prove every intermediate key was timed.

Navigation timing is touch-down to the last presented app frame within 1.5 s,
including the animation. It is not time to first readable content. Every trial
must contain animation frames. A long cursor-blink or unrelated app frame can
extend this conservative settling measure.

## Diagnostic status, not a performance gate

The command fails on invalid collection: wrong device/build/renderer, missing or
incomplete samples, missing presentation records, lost markers, invalid traces,
or unsaved fixture input. `EVIDENCE COMPLETE` means collection succeeded; it does
**not** mean performance passed. Counts and timing distributions remain visible.

The initial prototype enforced zero missed frames, a one-refresh sum of processing
stages, and a two-refresh input-to-draw limit. Those provisional performance gates
were removed after the maintainer clarified that an occasional missed frame is
acceptable and asked to stop chasing typing thresholds. They are not replaced with
looser thresholds chosen to produce green. The suggested 300-key, per-key presented
latency and stock-text-box comparison are not implemented acceptance tests.

Full scheduler/graphics tracing perturbed keyboard rendering during investigation;
it is not used for these measurements. Known negative process timestamp drops are
retained in the report; other trace import errors fail. This is opt-in physical
device coverage, outside CI. The pure collection/model tests run with
`just test-unit scripts/perf/android-real-input/model.test.mjs`.

## JNI cost and evidence

The Android-only adapter adds 119 Rust + 59 Kotlin source lines (178 total,
excluding blank lines and comments), plus call-site/build glue. Its Rust and
Android contract tests add 86 SLoC. It invokes the same canonical engine and
reuses UniFFI's generated result/error codec. Only replace and paragraph-key calls use this adapter. Composition updates and
commits still use the generated UniFFI/JNA path, so benefit depends on the IME.
The rest of the app still uses UniFFI/JNA; no dependency or APK-size reduction is claimed.

The maintenance cost is three handwritten JNI entry points, explicit enum tags,
and ownership of a cloned UniFFI Arc handle. Tests cover exact UTF-16 (including
lone-surrogate rejection), typed failures, payload validation and handle release.
The adapter must be revisited when the generated handle/codec contract changes.

Historical measurements, **not an isolated A/B of the current recovery-free build**:

| Measurement on Moto                                        | Before         | After          | Qualification                                                                      |
| ---------------------------------------------------------- | -------------- | -------------- | ---------------------------------------------------------------------------------- |
| Small-note engine/bridge stage, original JNI prototype     | 10.1 ms        | 4.9 ms         | Earlier synthetic benchmark; CPU scheduling/input boost differed from real typing. |
| Long-paragraph editor-stage p95, two real-keyboard windows | 5.77–6.07 ms   | 4.13–4.44 ms   | Also removed the unused WebView; cannot attribute the whole reduction to JNI.      |
| Same real-keyboard runs, input-to-onDraw p95               | 36.88–37.77 ms | 36.06–36.84 ms | About 0.8–0.9 ms improvement; not compositor presentation latency.                 |

The latter runs are retained as `b8ce0fbc-*` and `bfe1f656-*` under `.futo/runs/`.
They used the older recovery-enabled engine. Recovery removal was already merged
into main, but this checkout had lagged behind it; the cleanup integrates that
accepted change and removes the experimental recovery-I/O optimization. None of
these old timings proves the exact JNI gain in the newly installed build.
