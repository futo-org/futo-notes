# Android text-first renderer — handoff (updated 2026-11-02, evening)

The Android renderer for the Rust text-first engine works end to end in debug builds. Typing is
now fast on most corpus shapes but **not at the bar** on every note. This file is the state and
every known piece of remaining work. Delete it in the commit that ships or replaces this work
(repo archive rule).

The bar (Justin, 2026-11-02): 60 fps typing on the Moto g play 2023 (`ZY22HSGXSG`) — every
typed key, Enter and Backspace is drawn in the first frame after it (**frames late = 0 at
p95**), on every note in the `../futo-notes-ml` corpus, on a release-like build. Engine
bottlenecks are fixed in the shared Rust crate as part of it.

## 1. Where things are

| What                     | Where                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / MR              | `android-text-first`, draft MR !564 (CI on).                                                                                                                                                                                                               |
| Prototype, not merged    | JNI keys are now integrated; transport cost/limits are recorded in scripts/perf/android-real-input/README.md.                                                                                                                                                                              |
| !565 (drop recovery log) | Merged from main; current renderer uses debounced saves, with no recovery log.                                                                                                                                                                                                     |
| Renderer code            | `apps/android/app/src/main/java/com/futo/notes/textfirst/`                                                                                                                                                                                                 |
| Engine climbs merged     | nested lists cut at any depth (`inline/row/context.rs`), blank lines inside them, tables cut at row lines (`row/split/seams.rs`), per-segment span sweeps (`inline/edit/span_sweep.rs`). Specs: `docs/spec/editor/portable-core/{tables,long-regions}.md`. |
| Device claim             | the Moto is claimed by `../futo-notes-android-text-first`; `just qa-release android` there.                                                                                                                                                                |
| Flag / feel builds       | unchanged: `TextFirstFlag` on in dev ids; `./gradlew -PfutoDebuggable=false :app:installDirectDebug`.                                                                                                                                                      |

### Architecture in one paragraph

`TextFirstEditorScreen` (separate from `NoteEditorScreen`, routed in `MainActivityShell` when the
flag is on) hosts a `TextFirstEditText`. `EditorEngine` owns the `NativeEditorSession` on a
dedicated `HandlerThread`; the keyboard's `EngineInputConnection` is dispatched on that thread
(Chromium-style `getHandler()`), edits go to the engine, and `DisplayMirror` keeps the keyboard's
copy of the text plus a UTF-16 ⇄ UTF-8 index (`DisplayIndex`). Accepted changes become
`UiUpdate`s (text edits + span windows from `SpanPlan`) applied on the UI thread. The view's text
storage is `ChunkedEditable` (line-aligned chunks of `SpannableStringBuilder`, spans cut per line)
because a single `SpannableStringBuilder` does whole-note work per edit and per frame. An input
filter refuses any edit that did not come from the engine. A zero-width end sentinel keeps the
last line non-empty (Android lays out no paragraph spans for an empty last line).

## 2. Tools

- `just bench-text-first [--only label,…] [--profile N] [--no-fast-keys]` — the phone loop: 8
  corpus notes (one per known slow shape + small ones), fresh install, baseline profile compiled,
  30 keys per action in a 3 s box, keys at a random point of the frame. Prints per key p50/p95,
  **frames late**, on-time count, refusals, and stages: `engine` (key handed over → engine call
  returned, bindings included), `kotlin`, `queue`, `text`, `spans`, `frameWait`, `draw`.
  `--profile N` saves a simpleperf trace in the evidence dir. ~70 s now; slow notes still
  stretch it. The full run is `just test-android-text-first-bench --typed 30` (~6 min).
- `just engine-keys [files | synthetic:<shape>]` — the engine alone on this machine, with work
  counters (parsed / materialized bytes, link items, projection blocks).
- `just engine-keys-device …` — the same, cross-compiled and run natively on the claimed phone.
  The Moto is 12–48× slower than the desktop depending on shape; desktop ms are only a proxy.
- `just engine-climb push <name>` / `results [prefix]` — queue an engine attempt on CI's serial
  runner (#114 `futo_notes_serial`, one job at a time; it also runs `test:cross-platform-sync`).
  Each job runs the editor+store tests and benchmarks the attempt against its base, both built in
  the job, interleaved. Separate `engine-climb/*` branches, non-interruptible, never auto-cancelled.
- `TextFirstFfiCallBenchmarkTest` (opt-in `-e textFirstFfiBench true`) — binding call costs.

Bench traps found (fixed): `UiAutomation` (even `FLAG_DONT_USE_ACCESSIBILITY`) switched
accessibility on in the app — every Moto number before `9ac807cbf` paid accessibility events the
Moto does not send (no service is bound). A fixed key rhythm lined keys up just after a vsync.
Under instrumentation the app's AOT code is not used (JIT only), so Kotlin cost is pessimistic.

## 3. State and remaining work

### 3.1 Where the Moto is (p50 per key unless noted)

Fixed 2026-11-02: open of the 19k-line note 22.8 s → 4.3 s; typing there 132 → 17 ms; nested
list 1,754 → 29 ms; 125k-char list 72/139/72 → 18/18/19 ms; 30k table 263 → 26 ms; 11k-char
one-line paragraph 86 → 38 ms. Engine per key on desktop is now ≤ 0.25 ms on every synthetic
shape (one-line paragraphs, nested lists and tables are cut into local rows).

Quick set on `891f92fc6` (`just bench-text-first`, 98 s): every note/action is within 1–2
frames late at p95; worst p95 44 ms (was 1.8 s). Small notes draw on time for 10–26 of 30 keys.
The last full corpus run predates the engine merges (41% on time); rerun it
(`just test-android-text-first-bench --typed 30`) for the current figure.

What still makes keys late, largest first:

1. **The engine call's JNA overhead** (every note). Rust alone is ~1 ms/key on the Moto for a
   small note; the call returns after 5–10 ms. UniFFI's Kotlin bindings build several JNA
   `Structure`s per call by reflection, worse after the CPU idles between keys (a key pair: 5.3 ms
   hot, 9.7 ms after 20 ms idle). The Moto has no ADPF hint sessions. `proto/jni-keys` halves the
   stage (small note 10.1 → 4.9 ms; on-time 11/30 → 24/30). **Decision for Justin** (§3.4).
2. **One-line prose paragraphs** (a common corpus shape: 2–11k chars, no newline). The engine
   is fixed (word seams, 0.03 ms desktop), but Android re-lays out and redraws the whole
   paragraph per key (text 20 ms, draw 9 ms at 11k chars;
   `DynamicLayout.contentMayProtrudeFromLineTopOrBottom` is a quarter of it).
3. **Numbered nested list** (6ae4d2): Backspace engine ~12–19 ms on the Moto; Enter on an empty
   middle item refused (§3.4).
4. **Huge-note Enter/Backspace**: kotlin 2.7–4.6 ms (DisplayIndex rebuild is linear), spans
   2–4 ms.
5. **Open**: 4.4 s for the 19k-line note — `planSpans` over the whole note on the editor thread
   and `DynamicLayout` over 320k chars on the UI thread (blocks it; AGENTS M1).
6. Tables: Enter/Tab inside a cell, typing `|`/`\`, paste and row/column commands still read
   the whole table (cheap scan, ~0.4 ms at 200 rows desktop).

### 3.3 Correctness and features

Stage 1 (current stage) leftovers:

- `puppet` cannot see or drive the text-first view (papercuts filed): `OpenNote` reports a false
  refusal, `type` refuses, `doc`/`state` show no note, and it hardcodes `com.futo.notes.dev`.
  QA relied on `adb shell input` + screenshots + logcat (`TextFirstIme`, `TextFirstEngine`,
  `TextFirstApply`, `TextFirstWatchdog`). Needed before agent QA can scale.
- Camera image insert drew the photo behind un-displaced text (Justin, once); not reproduced via
  the library picker. Defensive fixes landed (EXIF rotation, re-measure on resize, relayout on
  bitmap load). The camera can kill the app's process on the Moto, after which the photo is lost
  (check whether the WebView editor behaves the same).
- Wikilink labels are a `ReplacementSpan` and do not wrap; long labels run off-screen.
- Inline code background fills the whole line height (Milkdown uses padding and radius).
- Held indent: only the plain typing path consumes it (`replace_action_mapped`); OS replacement
  and composition commits do not. Gboard committed per character in tests, but other keyboards
  compose.
- Sync while editing is simplified: a dirty editor ignores remote changes until its next save
  persists-or-parks; a remote rename while dirty is not followed.
- The editor thread calls the Store outside `NotesStore`'s storage-migration gate.
- `EditorEngine.kt` is 19,995 bytes (pre-commit limit 20,000); split along real seams before adding to it.
- Debug-only diagnostics to remove or gate before shipping: `TextFirstIme` keyboard trace,
  `TextFirstApply`/`TextFirstEngine` change logs, `MainThreadWatchdog`.

Stages 2 and 3 (agreed order):

- Stage 2: link editing (toolbar Link is disabled), wikilink completion menu, clipboard paste of
  images, remote images (only vault images load).
- Stage 3: tables UI (grid, `table_key`/`table_command`), find bar, front-matter panel,
  footnotes/HTML rendering, Copy Draft screen. Under !565 a failed save on leaving a note loses
  the unsaved edits (toast only) until Copy Draft exists.

### 3.4 Decisions still open

- **JNI fast path** (`proto/jni-keys`): adds a second FFI pattern next to UniFFI for the per-key
  calls only, same byte encoding and generated readers. 3A merge it / 3B stay on JNA and trim calls.
- **Enter on an empty middle item of a nested numbered list**: outdent (4A) or keep the refusal
  and record it in `lists.md` (4B).
- !564 vs !565 persistence (recovery log or not). Pick one before stage 2.

## 4. Device and environment notes

- The Moto's auto-rotate was turned off during testing (it rotated mid-run); turn it back on in
  quick settings if wanted.
- Gboard on the Moto has "Auto-space after punctuation" on: typing `?` commits `"? "`. Not an
  editor bug (the search field does the same).
- `.papercuts.jsonl` in the android-text-first worktree has two uncommitted puppet papercuts.
- Nested-list fuzz caveat: at 48k adversarial steps the deep-cut engine and its never-cut twin
  disagreed 3–4 times, only on notes full of stray backticks/`<!--`; each matched base on a
  fresh open. One case is a refusal the old whole-list planning raised for text ~7 KB away.
