# Android text-first handoff: Build, run, test

[← handoff index](README.md)

## 3. Build, run, test

First time in a fresh checkout or worktree: run `just android-native` once. It writes
`local.properties` and generates the gitignored UniFFI bindings. Without that, Gradle fails
with "SDK location not found" or missing UniFFI symbols. After any Rust/FFI change, rebuild
the bindings (`just build-rust-android device`), or you are testing yesterday's Rust.
`apps/android/AGENTS.md` has the full list of traps. Read it.

```bash
eval "$(just qa-claim android)"     # claim a pooled emulator: sets ANDROID_SERIAL / ANDROID_AVD_NAME
just android-native                 # Rust FFI (device ABI) → installDirectDebug → launch
just build-android-native           # compile both flavors (direct, play)
just test-android-native            # JVM unit tests, both flavors (~497 each)
just test-android-native com.futo.notes.textfirst.RenderWorkTest      # one JVM class

# Device (instrumentation) tests: the fast loop. Builds once, installs only on change,
# runs every selector in one `am instrument`. Emulators you claimed only (it clears app data).
just test-android-ui com.futo.notes.textfirst com.futo.notes.editor   # the text-first suite + FFI contract
just test-android-ui com.futo.notes.textfirst.TextFirstCaretTest#emptyListRowsHighlightOnlyTheirSelectedNewline
just qa-claim android --extra && just test-android-ui --shard         # split over 2–3 emulators
just test-android-native-ui         # same tests through Gradle connectedDirectDebugAndroidTest (CI parity, slow)

just test-rust                      # Rust workspace
just test-editor-wasm               # the engine's compiled-WASM consumers
```

Measured 2026-11-05 on one warm x86_64 emulator: one class takes about 10 s. The whole
243-test suite took 296 s in one call, or 107 s sharded over three emulators
(`docs/agents/android-device-tests.md`).

To judge feel, build non-debuggable:
`./gradlew -PfutoDebuggable=false :app:installDirectDebug` from `apps/android` (same `.dev`
id and data). Debuggable builds run Compose 2–4x slower.

**Perf benches** (opt-in, need a claimed device):

- `just test-android-text-first-bench`, and `just bench-text-first` for the ~1-minute quick
  loop: key to drawn frame over corpus notes.
- `just test-android-real-input`: real keyboard typing on the Moto. See
  `scripts/perf/android-real-input/README.md`.
- In the instrumentation run, the opt-in timing tests (`TextFirstTypingBenchmarkTest`,
  `TextFirstCommandBenchmarkTest`, `TextFirstFfiCallBenchmarkTest`,
  `NativeEditorKeystrokeLatencyTest`, `NativeEditorPerformanceReconTest`) skip unless enabled.

### Driving the app: puppet

`just puppet` is the one way to act on and read a running debug build. Load
`.claude/skills/puppet/SKILL.md`. Android:

```bash
FUTO_PUPPET_TARGET=android just puppet look        # screen, verbs, state
FUTO_PUPPET_TARGET=android just puppet doc         # the open note's lines, kinds and saved markdown
FUTO_PUPPET_TARGET=android just puppet do OpenLink # verbs the screen registers (PuppetVerbScope)
FUTO_PUPPET_TARGET=android just puppet tap '{"x":…,"y":…}'   # real touch (dp); "hold" for long press
FUTO_PUPPET_TARGET=android just puppet type '{"text":"…"}'   # real key presses
FUTO_PUPPET_TARGET=android just puppet file '{"noteId":"…"}' # the note on disk
```

Puppet uses the native editor in every build. Editor state comes from
`PuppetNativeEditorState.kt`, and editing actions use the platform input connection. Puppet `tap` has no multi-tap,
so double- and triple-tap can't be driven (papercut pc_a064c59be877).

### Devices

- **Emulators:** the `futo-qa-*` pool via `just qa-claim android`, at most three per worktree.
  The pooled AVDs have `hw.keyboard=yes`, which hides the soft keyboard. For IME and toolbar
  stories run `adb shell settings put secure show_ime_with_hard_keyboard 1`.
- **Low-end reference phone:** Moto g play (2023). It is the phone the typing budgets are set
  for. The real-input runner supports only its 720×1600 keyboard maps.
- **Pixel 7a** (Android 15): used for Mason's feedback round. Gboard is not installed on it.
- **jfedora:** Justin's Linux box (32 cores, KVM), preferred for heavy builds and Android
  emulators. A budget Android phone was reported attached there on 2026-10-31, so confirm
  its serial and availability before use. Access goes through Justin.

### CI jobs that cover this branch

| Job | What it covers for Android text-first |
|---|---|
| `build:android-native` (`ci/android.yml`) | Rust FFI for every ABI, `assembleDirectDebug` + `assemblePlayDebug`, JVM unit tests for both flavors, then `scripts/ci-android-instrumentation.sh`, which runs the **whole** androidTest suite (`textfirst` included) via `connectedDirectDebugAndroidTest` on a CI emulator (Android 14 AVD). Runs when an MR touches `apps/android/**`, `crates/futo-notes-ffi/**`, `Cargo.lock`, and a few others. About 33–65 min. |
| `test:rust:ffi-android` | FFI cross-compile for aarch64 Android. |
| `test:rust:workspace` | All engine/store/FFI Rust tests. |
| `test:cross-platform-sync:android` | Real Compose app plus sync on an emulator, using the native editor. The native cutover passed all three Android/desktop scenarios. |
| `test`, `test:e2e:*`, `test:ios-native`, `test:cross-platform-sync` | Not Android-specific, but they break when shared crates or spec-driven fixtures change. |

Pipeline 39656 at `c6392ed34` passed. The pipeline for `dbe0c2a92` (39724) was still running
when this was written.

### Known CI flakes, and how to tell them from real failures

- **Five "failed" tests in the JUnit report of a green `build:android-native`.** These are the
  opt-in perf tests above throwing `AssumptionViolatedException`. GitLab counts them as
  failures, but the job passes. Open !587 moves them out of the instrumentation run.
- **AGP test-listener crash.** In pipeline 39656 the first `build:android-native` attempt
  failed with
  `failed to report executionFinished for ...NativeEditorContractSurfaceTest.tagsFindAndClipboardKeepExactBytes`
  / `ArrayIndexOutOfBoundsException` in `AndroidTestResultListener`. A retry with no code
  change passed. Retry once. If the same test fails twice, or fails locally under
  `just test-android-ui <Class#method>`, treat it as real.
- **A wrapped-wikilink tap test** returned caret 7 instead of 118 in pipeline 39627
  (`6a1712e4e`). It does not appear among the failures in 39656. It may be flaky; unverified.
- **Local only:**
  - A claimed emulator can vanish from adb mid-run (pc_10deeba83e18). Reboot the claim; it is
    not an app failure.
  - Running two Android recipes in one worktree at once races APK packaging. You get
    "Could not find EOCD" or an APK without `libfuto_notes_ffi.so`. Run them one at a time.
  - `test-android-native-ui` with several classes used to run only the first. The
    `test-android-ui` loop checks every selector ran.
- Pipelines 39625–39630 failed `test:rust:workspace`, `test:ios-native` and the sync jobs on
  inherited test expectations that !590 corrected. That is history, not a current flake.
