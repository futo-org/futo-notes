# Editor Strategy Decision — Full Native vs Full CM6

> **Status: DIRECTION SET (provisional verdict, §6, 2026-07-13) — mobile goes
> native on the shared Rust engine; desktop stays CM6/Tauri for now.**
> Created 2026-07-10. Criteria were fixed before the experiments ran. The
> §6 ship gates (notably widgets-ON large-note perf and the live-keyboard
> matrix) must go green per platform before that platform's webview editor
> is replaced; the Evidence Log keeps accumulating until then.

## 1. The decision

Two end states are on the table. Both have exactly one editor "brain";
they differ in which one and in who owns rendering + input:

- **A — Full native.** One Rust engine (`crates/futo-notes-editor`,
  268/268 markdown-spec fixtures headless) + thin per-platform renderers:
  GPUI desktop, TextKit 2 iOS, Jetpack Compose Android. The TS/CM6 editor
  is deleted.
- **B — Full CM6.** The webview editor stays on all platforms (Tauri
  desktop + WKWebView/Android WebView embeds). The Rust engine and the
  gpui/TextKit2 work are parked. The app↔editor seam gets the bridge
  focus/IME protocol investment instead.

Hybrids (CM6 desktop + native mobile) are rejected as a *permanent* state:
two implementations of editor semantics is M6 at editor scale, and the
conformance-lock tax compounds forever on the highest-churn subsystem.
A hybrid may still occur as a *transition* under A.

**Asymmetry that assigns the burden of proof: B is reversible, A is not**
(deleting CM6 destroys a working editor; parking the engine doesn't).
Therefore every experiment below is designed to *falsify A*. A wins only
by passing all P0 criteria; any P0 kill and we take B (or iterate and
re-run, if the failure has a named, bounded fix — same graduate/kill/iterate
discipline as the POC plan).

## 2. What we already know (evidence log)

| Evidence | Source | Points toward |
| --- | --- | --- |
| Engine passes all 268 fixtures headlessly, ms-fast | `crates/futo-notes-editor` conformance harness (gpui branch) | A viable |
| gpui desktop app built M0–M8 in ~2 days on the engine, incl. sync | `worktree-gpui-desktop-rewrite` July 3–4 commits | A cheap to build |
| TextKit2 POC P0–P5 complete: FFI EditorEngine, layer-2 Swift harness, editing loop w/ IME guard, commands | `poc/full-native-editors` | A viable on iOS |
| Naive side-by-side on iPhone: TextKit2 vs WebKit hard to tell apart (selection/caret NOT pushed) | Manual, 2026-07-09 | Feel is a wash on iOS (both are Apple's text stack — D1 working as designed) |
| Small-note typing healthy native (p50 14ms ≈ 1 frame, 0 drops); in-loop work ~0.4ms | POC verdict P5 (simulator) | A viable |
| 10k-line note was CATASTROPHIC native (p50 ~1.8s/keystroke, whole-doc overlay reposition), then fixed: viewport-bounded overlays, >2k-line notes fall back to visible markers; post-fix 10k open 435–507ms, scroll 1 hitch/3.3s | POC verdict P5 + post-P5 fix | Was a kill; now "iterate" — device re-verify needed. Note the >2k-line fallback is a UX regression to price in |
| IME marked-text mechanics pass via harness (real setMarkedText path, restyle deferred during composition, zero divergence) | POC verdict P3 | A viable — but live-keyboard JP/dictation/swipe are device-pending |
| Native AX shape measurably bad today: raw markers in AXValue, orphan overlay StaticTexts, checkboxes invisible to AX. Webview unmeasured (WK AX invisible to sim tooling) | POC verdict P5 VoiceOver | Open risk for A (and unknown for B) |
| Webview 10k: p50 1ms but p95 170ms, fell ~7s behind during paced typing (no loss); scroll 0.8% hitch | POC verdict P5 | B is not perfect either at 10k |
| App↔editor seam produced ~20 commits of tap/caret/IME whack-a-mole in 3 days (July 7–10), plus the isMobile saga, vh/dvh=0, scroll-jank height-map warming | git history, main | B's recurring tax |
| Memory (sim, indicative): native ballooned to 1.2GB during the pre-fix 10k overlay churn; webview stable ~430+490MB across processes | POC verdict P5 | Re-measure post-fix |
| E2 device perf (iPhone 17 Pro, iOS 26.5.1): native 10k setContent 483.8ms; 200-key p50/p95/max 21.5/67.7/85.3ms vs CM6 38.0/43.0/87.0ms (native p95 = 1.57× CM6); native scroll 0/144 hitches over 2.39s; settled content visible inside the 1s gate; tapped-line edit persisted; no caret-to-end, blank-viewport, divergence, crash, or jetsam; native physical footprint 32.6MiB (101.3MiB real memory) | E2 physical-device pass, 2026-07-10 | P0-3 pass on device |
| E2 giant-note UX: the native >2k-line safety fallback shows raw `- [ ]` markers rather than rendered/interactive checkboxes; during the device pass this read as “checkboxes did not render properly” | E2 physical-device pass + observer report, 2026-07-10 | Negative for A under P0-5/P2-9 despite the perf win |
| Android E1 spike (2026-07-11): ~450-line AppCompatEditText adapter over the same EditorEngine FFI. Layer-2 conceal conformance green across all render-only corpus cases on a real Android text stack; IME-guard harness green (romaji-style composition adjacent to concealed markers via the view's real InputConnection: mirror synced live, composing span survives, deferred restyle drains oracle-exact on commit); live emulator loop verified — tap placed the caret at the tapped char first try, cursor-reveal fired, typed text persisted to disk inside intact markers; zero divergence hits anywhere | `apps/android/.../editor/`, `NativeEditor*Test.kt`, Pixel 7 Pro AVD `futo-editor-spike` | A viable on Android (adapter half); live-keyboard + perf + selection legs still open |
| Android spike friction: none structural — Kotlin bindings fell out of build-rust-android.sh unchanged, UTF-16 engine offsets are Java string offsets (no conversion layer), zero markdown knowledge needed in Kotlin (D1 held) | E1 spike commits on this branch | A cheaper than budgeted on Android |
| Android E4 widget spike (2026-07-11): table renders as a real grid + image as an inline bitmap via per-line ReplacementSpans (NO overlay views — the iOS overlay tax never materializes); editing came FREE via the engine's region-scoped reveal (tap cell → grid dissolves to pipes → edit → grid re-renders, persisted to disk); 8/8 instrumented tests green incl. table-cell edit round-trip asserting engine TableData; zero divergences; ~4h of a 2-day timebox; D1 held (zero pipe/image parsing in Kotlin) | E4 commits 72e43b9+5df0bdb, `test-screenshots/e4-*.png` | P0-5 PASS on Android |
| Android E4 caveats: line-height jump when an image span reveals/conceals (wants smoothing); TalkBack sees raw markdown (ReplacementSpans are visual-only) — same class as iOS's AX gap but better shaped (one coherent EditText node, no orphan flood); table delimiter row renders as a thin gap (cosmetic) | E4 report | Feeds P1-6 (a11y), not P0-5 |
| E2 device IME: Japanese candidate selection, mid-composition caret editing, candidate-bar reconversion, line-boundary composition, heading-boundary autocorrect, and QuickPath all preserved exact text; dictation looked correct onscreen but reproducibly persisted a hidden U+FFFC object-replacement character in a fresh isolated note | E2 physical-device pass + byte-for-byte vault inspection, 2026-07-11 | P0-1 iterate — bounded TextKit dictation-placeholder mirroring defect |
| E2 selection A/B after syncing main's mobile-selection fixes: native TextKit 2 long-press caret placement, handle-drag selection, and triple-tap line selection passed; CM6 long-press navigated the wikilink on 5/5 attempts and triple-tap selected only `as with ` rather than the full line | E2 physical-device pass, iPhone 17 Pro, 2026-07-11 | Strongly favors A for selection feel; CM6 has a repeatable mobile parity regression |
| E2 real-device VoiceOver A/B: CM6 announced the heading twice without a heading role, trapped swipe focus there, and stopped continuous reading after the following sentence; however, both task items exposed correct checkbox label/role/state/action. TextKit 2 read the raw heading `#` and bold `**` markers, omitted heading semantics, and exposed both task items as raw punctuation/text with no checkbox role, state, or action; wikilink brackets stayed concealed | E2 physical-device pass, iPhone 17 Pro, 2026-07-11 | P1-6 remains open; B is imperfect, but A has the more serious control-accessibility gap and needs a concrete AX remediation design |
| E2 controlled 10-second native-scroll repeat: no observer-visible blank viewport, caret jump, freeze, or obvious hitch; probe logged 647 callbacks over 9.91s (15.3ms mean), 330 nominal hitches, worst 29.1ms. The nominal 51.0% is not credible: `DevLatencyProbe` compares callback deltas to `CADisplayLink.duration`, which can remain 8.3ms on ProMotion while callbacks dynamically throttle near 60–65Hz, misclassifying ordinary frames. This contradicts the earlier 0/144 run and requires a refresh-rate-aware counter before the ≤2% gate can be considered measured reliably | E2 physical-device pass + console, iPhone 17 Pro, 2026-07-11 | P0-3 iterate on instrumentation; correctness/open/typing/memory bars remain green |
| Android 10k perf A/B (2026-07-11, emulator+swiftshader — indicative): TYPING native clean, p50–p99 pinned at one vsync (16ms) vs webview p99 32ms, 0 divergences over 30 keys. OPEN native worst real frame 129ms vs webview 150ms. **SCROLL native FAILS: 94.7% janky, p95/p99 200ms vs webview 3.8% janky, p99 38ms** — the naive single-EditText-over-10k-line-spannable does not scroll; same class as iOS's pre-fix 10k problem, same known fix direction (viewport-scoped rendering). Frame counts not comparable cross-editor (WebView composites on its own RenderThread); percentiles within a capture are | android-10k-perf A/B run, `test-screenshots/perf-*.png` | P0-4 perf leg: typing/open pass, scroll = iterate-with-named-fix |
| Desktop 10k A/B (2026-07-11, Fedora Wayland, debug builds — cross-editor numbers directional): both editors viewport-lazy, NO O(doc) per-keystroke blowup. gpui structural re-render ~1.8ms/keystroke (headless, fake shaper; engine floor 40µs); CM6 compute ~1ms but keystroke→frame p50 84ms / p95 107ms GPU-composited (191ms under the software-render dev flag) — the browser reflowing the 300k-px container, corroborating the iOS webview 10k tail. CM6 scroll excellent (0.7% hitch GPU / 4.1% software). gpui real-window latency UNMEASURABLE headlessly: native-Wayland unfocused surface got zero frame callbacks; XWayland throttled to 15fps (M21 class) — needs a human-focused window pass. gpui correctness on 10k: open/type/scroll/quit clean via real code paths; mouse-click caret NOT exercised | desktop-10k-perf A/B run, probe commit 97b79c6, `test-screenshots/desktop-cm6-10k.png` | P2-9: CM6's 10k typing tail is real on desktop too; gpui structurally sound, presentation-latency leg still open |
| gpui build/run friction on stock Fedora Wayland (P1-7): links -lxkbcommon-x11 even for Wayland (needs libxkbcommon-x11-devel or RUSTFLAGS workaround); no offscreen/headless render path for perf capture; unfocused native-Wayland window never draws | desktop-10k-perf run | P1-7 gap list grows: dev-box setup + headless-render tooling |
| Gate-1 iOS widgets-ON 10k (2026-07-13, sim — same rig as P5 baseline): >2k fallback REMOVED, widgets at any size via viewport-scoped overlays (O(viewport) rebuild, was O(doc)); open 522ms, typing p50/p95 23.3/37.3ms 0 drops (pre-fix: 1762ms+), overlay reposition 6.7ms/turn (was 1562ms), AX tree 129 elements BOUNDED (was thousands), memory 419MB max (was 1235MB); scroll 6.0% hitch under a deliberately-harsh 7200px/s fling (was 17.5% raw-marker) — ≤2% gate scored on device only. 30 tests green. Widget baseline-alignment polish noted (glyphs sit slightly low mid-scroll) | ios-widgets-perf, commits 5a451f4/25e12d0/6cd975e, `test-screenshots/gate1-10k-tables-*.png` | P0-5 iOS: fallback gone, widgets-on gates pass except device-pending scroll |
| Gate-1 Android widgets-ON 10k (2026-07-13, emulator): diagnosis found the REAL open cost — styling all 10k lines was a ~6.9s synchronous block that rendered zero frames, so prior gfxinfo "open" numbers never saw it; fixed via bounded styled-prefix (151 lines/78ms at open) extended on scroll, never un-styled. Full WidgetKind set as per-line ReplacementSpans (checkbox/bullet/number/code-label/hr). Results: open worst frame 750ms PASS; scroll p50/p95/p99 14/22/29ms — now BEATS webview percentiles (16/32/38), nominal 15.25% janky vs strict 2% = device-pending (deadline accounting on software GPU; was 94.7%); **typing regressed: p50 65/p99 81ms vs 16ms widgets-off, above the 64ms (2× webview) gate — iterate, suspect per-flush lineStarts recompute over 10k lines + span churn**; zero divergences; persistence verified; 11/11 instrumented tests; styled-boundary artifact (one raw `-` at the prefix edge) noted | android-widgets-perf commits d1a8f3a9/087ce57f + this session's A/B run, `test-screenshots/gate1-android-*.png` | P0-4: scroll transformed, open honest-passed, typing = new named iterate |
| Interaction judge phase 1 (2026-07-13, Pixel 7a): factory-shaped harness driving native + CM6 legs (same app, pref flip) with identical adb gestures, diffing interaction outcomes via a debug ContentProvider (native) / CDP (CM6). Reproduced all 3 user-reported feel bugs as divergences with a clean CM6 baseline (oracle noise ±0.09%): fling travel 7% of CM6 (native never reaches fling velocity — scroll-ownership/movement-method class, NOT styling frame-steal); checkbox tap has NO toggle handler (caret lands in concealed marker range); selection DRIFTS on scroll (fling read as selection drag). All three converge on EditText touch/scroll ownership + one missing handler | interaction-judge, tests/interaction-judge/ | The feel-bug class is now harness-locked; fixes get regression scenarios for free |
| E6 retrospective (2026-04-12→07-11, main): editor/mobile-input bug fixes bucket SEAM 7 incidents (~20 commits, ~1.5–2k lines: isMobile leak, scroll-jank saga, WKWebView keyboard/viewport jumps, WebKit click-cancellation breaking link-follow+slash-menu, focused-adopt crashes, Android IME blur/renderer-crash/shield, inset coordination) vs SEMANTIC 5 incidents (~380 lines) vs NEITHER 5 small. A kills all 7 seam incidents structurally; the bridge focus/IME protocol (B's mitigation) cleanly prevents 1 (focused-adopt), partially 2, and does not address scroll ownership / embed gating / bridge affordances. April's editor build-out cluster excluded as greenfield. Judgment calls: native-toolbar chrome split between NEITHER/SEAM; 256e9c7's ~500-line churn part-feature | editor-bug-retrospective E6 report | B's recurring cost is a seam cost (4:1) and only minority-mitigated by the named protocol; A's semantics win is real but small |
| iOS dictation remediation (2026-07-13): the TextKit adapter now strips transient U+FFFC object-replacement placeholders before mirroring edits into Markdown. A regression test drives the real `NSTextStorage` processing path and proves storage, engine text, and emitted `onChange` content remain byte-clean; all 29 native tests pass. Live physical dictation still needs one confirmation run | `TextKitEditingConformanceTests.dictationObjectReplacementCharacterIsNotPersisted` + `just test-ios-native` | P0-1 has a bounded implemented fix; device recheck remains |
| iOS ProMotion probe remediation (2026-07-13): native scroll classification now uses the same fixed >25ms user-visible hitch threshold as the web probe instead of treating a possibly fixed 8.3ms `CADisplayLink.duration` as the callback schedule. Boundary tests cover 8.3–50ms. The physical 10-second run must be repeated before scoring the ≤2% gate | `TextKitLargeNotePerformanceTests` + `DevLatencyProbe.isScrollHitch` | Removes the known P0-3 measurement flaw; device remeasure remains |
| iOS E4 widget spike (2026-07-13): normal-size notes render engine-provided `TableData` as a native grid and engine-provided image widgets as scaled vault images. Table cells and image source Markdown edit through the real storage path and round-trip to engine data; visual simulator pass was clean. No pipe/image parsing was added in Swift; D1 held. The >2k-line raw-marker safety fallback remains | `TextKitWidgetTests`, iPhone simulator `futo-qa-6` | P0-5 normal-note iOS spike passes its timebox; giant-note fallback remains negative |
| iOS native accessibility remediation (2026-07-13): blurred TextKit reading mode now builds one engine-derived semantic tree with marker-free heading/static-text labels, heading role, actionable checkbox role/state, table rows without duplicate cell stops, and image alt text/role. Activating text returns to UIKit's native editing accessibility; >2k lines deliberately fall back to virtualized raw text. Automated activation tests and simulator AX inspection pass; physical VoiceOver reading order/rotor/toggle confirmation remains | `TextKitAccessibilityTests` + `idb ui describe-all` on `futo-qa-6` | P1-6 now has an implemented credible native design; device recheck remains |
| Interaction-judge fix pass (2026-07-13, Pixel 7a): all 3 feel bugs FIXED. `NativeEditorView` now owns vertical touch via OverScroller + GestureDetector on the EditText's own scrollY (styled-prefix `onScrollChanged` plumbing and IME deferral untouched by design — no scroll-container wrap). Fling travel 102% of CM6 (was 7%; velocity boost 2.5× + same-direction compounding, calibrated empirically against the CM6 oracle leg); caret drift killed two ways (ACTION_DOWN buffered until the gesture resolves to a real tap/long-press; `bringPointIntoView` honored only after a genuine caret move, never on styled-prefix relayout); checkbox tap hit-tests the glyph box → engine ToggleCheckbox EditPlan through the mirror loop (length-preserving, no caret shift). 3/3 judge scenarios green, zero divergences; 14/14 instrumented tests (3 new: toggle-through-mirror-loop, tap-on-text-no-toggle, scroll-no-selection-move); widgets-ON 10k scroll IMPROVED to p50/p95/p99 13/19/23ms, 0.97% janky (pre-fix baseline p99 29ms); typing path untouched (mirror integrity verified over a live burst, 0 divergences). Caveat: the fling boost was calibrated against adb-injected swipe velocities (VelocityTracker reads them slower than WebKit does) — a real-thumb feel re-test is the confirmation | interaction-fix commits aca1466d/f2b47161/f1c096f9, judge last-run 2026-07-13T23:41Z | The 3 feel bugs are fixed and harness-locked; residual risk = fling boost under real fingers |

## 3. Scorecard — criteria fixed in advance

P0 = kill criteria (A must pass every one). P1 = strong weight. P2 = tiebreak.

| # | Criterion | Threshold | How measured | Status |
| --- | --- | --- | --- | --- |
| P0-1 | iOS live IME correctness (device) | JP romaji composition (incl. candidate bar, mid-composition caret moves, reconversion), autocorrect, dictation, QuickPath swipe: zero dropped/duplicated/mangled text, zero divergence assertions | Device pass w/ console attached (POC verdict P3 "device-pending" rows) | **ITERATE — bounded fix implemented; physical recheck pending.** Japanese candidate/caret/reconversion/line-boundary composition, QuickPath, and heading-boundary autocorrect passed on iPhone. The sole failure was dictation persisting U+FFFC. The adapter now removes that transient placeholder before engine/onChange mirroring, and a real-storage-path regression test proves byte-clean output. Repeat fresh-note live dictation on the physical iPhone before PASS. |
| P0-2 | Selection/caret fidelity under conceal (device) | Cursor/motion fixture categories green through layer-2 harness; manual torture (tap into `**bold**`, handle-drag across concealed wikilink, double/triple-tap) at parity with CM6 side-by-side | Extend Swift layer-2 harness to motion cases + recorded manual A/B | PARTIAL — native manual torture passed on device: long-press caret placement, handle-drag across concealed markers, word selection, and triple-tap line selection remained stable. Updated CM6 comparison failed: 5/5 long-presses followed the wikilink, and triple-tap selected only `as with ` rather than the whole line. Native manual behavior exceeds CM6 here; layer-2 motion-fixture extension remains pending. |
| P0-3 | Large-note perf post-fix (device) | 10k note: open ≤1s, typing p95 ≤2× CM6 same device, scroll hitch ≤2%, no blank-viewport/caret-to-end bugs, memory sane | Re-run DevLatencyProbe device A/B (P5 said sim-only) | **ITERATE — corrected instrumentation; physical remeasure pending.** Open (483.8ms), typing (native p95 67.7ms vs CM6 43.0ms), memory (32.6MiB footprint), persistence, caret, and viewport correctness pass. The contradictory 51% scroll result came from comparing dynamically throttled callbacks with a fixed 8.3ms display-link duration. Native now matches the web probe's >25ms hitch threshold with boundary tests. Repeat the controlled 10-second device run to score the ≤2% gate. |
| P0-4 | Android adapter clears the same bars | P0-1/2/3 equivalents on a minimal adapter, tested against GBoard + FUTO Keyboard + one OEM keyboard | E1 spike + gate-1 widgets-on re-measure (2026-07-13) | PARTIAL — conceal/IME harnesses green, zero divergences ever. Gate-1 widgets-ON: open honest-PASS (the 6.9s hidden styling block found+fixed; 750ms worst frame); scroll TRANSFORMED (p99 200→29ms, now beats webview percentiles; strict ≤2% device-pending); **typing regressed to p50 65/p99 81ms (vs 64ms gate) — iterate: profile per-flush lineStarts recompute + span churn**. Remaining: typing fix, live-keyboard matrix (GBoard/FUTO/OEM), selection-handle torture, device scroll scoring |
| P0-5 | Widgets don't require markdown-in-Swift/Kotlin | One table + one inline image rendered AND edited per platform within a 2-day timebox each, semantics staying in the engine (D1 rule) | Extend POC scope; the >2k-line marker fallback UX counts here too | **PASS both platforms (2026-07-13).** Android ~4h spike + full WidgetKind set at 10k scale. iOS table/image round-trip green AND the >2k raw-marker fallback is now REMOVED (viewport-scoped overlays at any size — gate-1 evidence rows). D1 held everywhere. Residual polish: iOS glyph baseline alignment, Android styled-boundary artifact, image line-height jump — tracked as polish, not gate items. |
| P1-6 | Accessibility is fixable | Real-device VoiceOver pass BOTH editors; native needs a credible plan for marker-free reading + AX-exposed checkboxes (webview gets measured for the first time — it may be bad too) | Device pass + design note | **ITERATE — native remediation implemented; physical recheck pending.** The 2026-07-11 A/B exposed defects in both editors and the more serious missing-control semantics in native. TextKit now has an engine-derived blurred reading tree with clean heading/text labels, heading role, checkbox label/state/action, deduplicated table rows, and image alt/role; automated activation tests and simulator AX inspection pass. Repeat VoiceOver reading order, rotor navigation, edit activation, and checkbox toggling on the physical iPhone before PASS. |
| P1-7 | GPUI desktop has no >1-quarter gap | Daily-drive gpui app on real notes ≥3 days; gap list has nothing unshippable within a quarter (desktop IME, a11y, Wayland/Windows, packaging/updater) | Dogfood + gap log (extends the M8 audit) | PARTIAL — 10k A/B added first gap-list entries: X11-devel build deps on Wayland boxes, no headless-render path, unfocused-Wayland-surface never draws (probe-only concern?); 10k open/type/scroll/quit correct via real code paths. Dogfood + IME/a11y/packaging assessment still pending |
| P1-8 | Economics favor the winner | (a) Strand inventory both directions — A strands: Playwright/markdown-spec-runner/factory/agent-browser/MCP-bridge QA stack, CM6 itself. B strands: engine, gpui app, TextKit2 POC. (b) Retrospective: classify last ~3 months of editor/mobile bugs as seam-preventable / single-brain-preventable / neither | Analysis on main, no new code | **DATA COMPLETE (E6, 2026-07-12).** 3-month retrospective: SEAM 7 incidents/~20 commits/~1.5–2k lines vs SEMANTIC 5 incidents/~380 lines vs NEITHER 5 small — seam dominates ~4:1. **A structurally kills all 7 seam incidents; B's named focus/IME protocol prevents only 1 cleanly + 2 partially** — the rest (scroll ownership, embed-capability gating, openUrl/click-model bridge affordances) need an open-ended bridge-hardening program, so costing B off the one protocol understates it. Strands: A kills ~16–17k LOC (≈4.5k editor core + ≈8k QA scaffolding; YAML corpus and signed Tauri updater SURVIVE — desktop shell separable); B parks ~37–38k LOC already built and green (engine 16k, gpui 16k, mobile adapters ~5.6k). Judgment calls flagged in the E6 report (evidence log) |
| P2-9 | User-visible wins exist | Device: cold-open, keystroke latency, memory, battery — A should win somewhere users notice, else B's reversibility wins ties | Falls out of P0-3 probes | PARTIAL — iOS device: native p50 beat CM6, p95 slower (both inside P0-3); giant-note raw-checkbox fallback is a visible loss. Desktop 10k: CM6 carries a real typing-latency tail (p50 84ms keystroke→frame; 191ms p95 under the software-render path many Linux users actually get) while gpui's structural cost is ~1.8ms — potentially THE user-visible win for A, pending a focused-window measurement to confirm presented latency |

Decision rule: all P0 pass → A, with desktop (P1-7) allowed to lag mobile
in sequencing. Any P0 kill with no bounded fix → B, and the bridge
focus/IME state-machine proposal is executed instead. P1-8's strand
inventory sets the transition plan either way.

## 4. Experiments

Run in parallel where possible. Native-side work lives on
`poc/full-native-editors` (it has the reusable system: feature-gated pure
engine crates (P0), `export-spec` JSON corpus bin + `EditorEngine` UniFFI
surface (P1), Swift layer-2 harness (P2)). Analysis lives on main.

- **E1 — Android spike (highest information value; the long pole).**
  Branch `poc/android-editor` stacked on `poc/full-native-editors`.
  Minimal Compose adapter over the existing `EditorEngine` FFI (Kotlin
  bindings should fall out of `build-rust-android.sh`): engine decorations
  → spans, conceal, damage restyle. Port a Kotlin runner for the exported
  JSON corpus so verdicts are directly comparable to iOS. Then the IME
  torture list against 3 keyboards. Feeds P0-4.
- **E2 — iOS device pass (needs the Mac + physical iPhone).** Everything
  the POC verdict marks device-pending: live JP composition incl.
  candidate-bar/mid-composition-caret/reconversion + one multi-line
  composition probe, dictation, QuickPath, the DevLatencyProbe A/B on
  device, post-fix 10k re-verify, VoiceOver for BOTH editors. Feeds
  P0-1/2/3, P1-6, P2-9. Debug build, console attached (divergence
  assertions must be armed).
- **E3 — Selection/conceal torture.** Extend the layer-2 harness to the
  cursor/motion fixture categories on-device; recorded manual side-by-side
  vs CM6. Feeds P0-2.
- **E4 — Widget spike.** Table + inline image in the TextKit2 adapter
  (and E1's Compose adapter), 2-day timebox each. Overrun = data, not
  failure to schedule around. Feeds P0-5.
- **E5 — GPUI dogfood.** Daily-drive the gpui app (it has sync) on real
  notes; log gaps. Feeds P1-7.
- **E6 — Webview costing retrospective (main, analysis only).** Bug
  classification per P1-8b + strand inventories per P1-8a. Optionally land
  the 1-day host-asserted-IME bridge slice and watch a week of QA — a live
  test of "can the seam be tamed" that is useful under B either way.

## 5. Logistics

- iOS kill-tests: directly on `poc/full-native-editors`. Android:
  `poc/android-editor` stacked on it. Decision artifacts (this doc, E6
  outputs, the final verdict): main, cherry-picked to the POC branch so
  Mac-side work has them.
- The POC branch trails main (based pre-Prettier, pre-isMobile-removal).
  Do NOT pay the merge tax during the spikes; if A wins, rebase/extraction
  is the first transition task.
- The losing path gets parked with a written verdict in `docs/learnings/`
  (same discipline as the factory parking) so this doesn't get relitigated
  in three months.

## 6. Verdict (provisional — direction set 2026-07-13)

**Mobile goes native; desktop stays CM6/Tauri for now.**

- **iOS and Android replace their embedded webview editors** with the native
  renderers (TextKit 2 / EditText+spans) over the shared Rust engine.
  Grounds: no P0 kill across the whole falsification campaign; every failure
  converted to a bounded fix that was implemented and regression-locked
  within days; seam bugs dominate the webview's recurring cost 4:1 and the
  native path kills all of them structurally (E6); native selection already
  exceeds CM6 on iOS (P0-2); both adapters came in far under budget.
- **Desktop keeps CM6/Tauri** (user decision, 2026-07-13). Rationale: desktop
  is where the seam never bit (zero desktop incidents in E6 — the whack-a-mole
  was all mobile), CM6 scroll is excellent there, and the gpui app carries the
  largest remaining unknowns (dogfood, desktop IME, Windows, packaging).
  The gpui app + perf probe stay parked on their branch; re-evaluate desktop
  after the mobile transition ships. CM6's known 10k typing tail (p50 84ms)
  is accepted for now.
- **Consequence — the mandatory guard.** This transition state is exactly the
  two-brains hybrid §1 warns about, so its containment is now policy, not
  suggestion: the Rust engine is CANONICAL for editor semantics; any editor
  behavior change lands engine+fixtures first and the CM6 port second, in the
  same MR; the markdown-spec corpus is the cross-implementation contract
  (both consumers already run it in CI).
- **iOS physical rechecks waived as decision gates** (user call: the dictation
  U+FFFC, ProMotion-probe, and AX fixes are assumed sound — each carries a
  regression test). They move into the ship gates below.

### Ship gates — per platform, before its native editor replaces the webview

1. **Widgets-ON large-note perf (the gap the campaign left).** Every 10k perf
   number so far was measured with widgets off: iOS ran under the >2k-line
   raw-marker fallback, Android's E1 adapter rendered checkboxes/bullets as
   raw source, and the one widgets-on-at-scale datum is the pre-fix iOS
   1.56s/keystroke disaster. Implement viewport-scoped widget rendering on
   both platforms (lifts the iOS >2k fallback; fixes Android's failed scroll
   gate in the same stroke — checkboxes/bullets as per-line spans on Android,
   viewport-bounded attachments on iOS), then RE-RUN the 10k A/B with
   checkboxes, bullets, tables, and images actually rendering. Gates:
   open ≤1s, typing p95 ≤2× CM6, scroll hitch ≤2% — same thresholds as P0-3.
2. **Live-keyboard matrix.** Android: GBoard + FUTO Keyboard + one OEM —
   composition w/ candidate bar, swipe, autocorrect at marker boundaries
   (the least-derisked item left anywhere). iOS: the waived physical
   rechecks — fresh-note dictation, 10s scroll run, VoiceOver reading order
   + checkbox toggle.
3. **Device a11y pass** (VoiceOver / TalkBack) using the engine-derived
   reading tree — treat as a blocker, not a launch-day surprise.
4. **Feature parity vs docs/spec/editor.md** — toolbar exec map, wikilink
   autocomplete, image paste, link follow — checked per platform, plus the
   layer-2 conformance harness green on device (already standing).

### Next steps (condensed)

1. **Widgets-on viewport rendering + 10k re-measure, both platforms** — one
   workstream; subsumes the Android scroll fix, the iOS fallback lift, and
   ship-gate 1.
2. **Human feel re-test on the Pixel** — the 3 judge-locked feel fixes (fling,
   checkbox tap, caret-on-scroll) are green under synthetic gestures; the fling
   velocity boost was calibrated against adb-injected swipes, so a real thumb
   is the confirming instrument. Vault re-seeded, native pref on.
3. **Android live-keyboard matrix** (ship-gate 2's unknown half).
4. **Cut the transition plan**: rebase/extract the engine + adapters from the
   POC branch onto main behind the debug pref, then walk ship-gates 2–4 per
   platform and flip the default when a platform goes green.
