# Editor Strategy Decision — Full Native vs Full CM6

> **Status: information-gathering. No decision yet.**
> Created 2026-07-10 from the editor-strategy discussion. This doc fixes the
> decision criteria BEFORE the remaining experiments run, so the experiments
> can't become a ratification exercise. Update the Evidence Log as results
> land; the Verdict section stays empty until every P0 criterion has data.

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
| TextKit2 POC P0–P5 complete: FFI EditorEngine, layer-2 Swift harness, editing loop w/ IME guard, commands | `poc/ios-textkit2-editor` | A viable on iOS |
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
| E6 retrospective (2026-04-12→07-11, main): editor/mobile-input bug fixes bucket SEAM 7 incidents (~20 commits, ~1.5–2k lines: isMobile leak, scroll-jank saga, WKWebView keyboard/viewport jumps, WebKit click-cancellation breaking link-follow+slash-menu, focused-adopt crashes, Android IME blur/renderer-crash/shield, inset coordination) vs SEMANTIC 5 incidents (~380 lines) vs NEITHER 5 small. A kills all 7 seam incidents structurally; the bridge focus/IME protocol (B's mitigation) cleanly prevents 1 (focused-adopt), partially 2, and does not address scroll ownership / embed gating / bridge affordances. April's editor build-out cluster excluded as greenfield. Judgment calls: native-toolbar chrome split between NEITHER/SEAM; 256e9c7's ~500-line churn part-feature | editor-bug-retrospective E6 report | B's recurring cost is a seam cost (4:1) and only minority-mitigated by the named protocol; A's semantics win is real but small |

## 3. Scorecard — criteria fixed in advance

P0 = kill criteria (A must pass every one). P1 = strong weight. P2 = tiebreak.

| # | Criterion | Threshold | How measured | Status |
| --- | --- | --- | --- | --- |
| P0-1 | iOS live IME correctness (device) | JP romaji composition (incl. candidate bar, mid-composition caret moves, reconversion), autocorrect, dictation, QuickPath swipe: zero dropped/duplicated/mangled text, zero divergence assertions | Device pass w/ console attached (POC verdict P3 "device-pending" rows) | **ITERATE — iPhone 17 Pro, 2026-07-11.** Japanese candidate/caret/reconversion/line-boundary composition, QuickPath, and heading-boundary autocorrect passed. Dictation visually passed but fresh-note vault inspection reproducibly found a hidden U+FFFC character, violating zero-mangled-text. Likely bounded cause: a transient TextKit dictation attachment placeholder is mirrored into Markdown by the `.editedCharacters` path. |
| P0-2 | Selection/caret fidelity under conceal (device) | Cursor/motion fixture categories green through layer-2 harness; manual torture (tap into `**bold**`, handle-drag across concealed wikilink, double/triple-tap) at parity with CM6 side-by-side | Extend Swift layer-2 harness to motion cases + recorded manual A/B | PARTIAL — native manual torture passed on device: long-press caret placement, handle-drag across concealed markers, word selection, and triple-tap line selection remained stable. Updated CM6 comparison failed: 5/5 long-presses followed the wikilink, and triple-tap selected only `as with ` rather than the whole line. Native manual behavior exceeds CM6 here; layer-2 motion-fixture extension remains pending. |
| P0-3 | Large-note perf post-fix (device) | 10k note: open ≤1s, typing p95 ≤2× CM6 same device, scroll hitch ≤2%, no blank-viewport/caret-to-end bugs, memory sane | Re-run DevLatencyProbe device A/B (P5 said sim-only) | **ITERATE — measurement instrumentation, iPhone 17 Pro.** Open (483.8ms), typing (native p95 67.7ms vs CM6 43.0ms), memory (32.6MiB footprint), persistence, caret, and viewport correctness pass. The first scroll run logged 0/144 hitches; a controlled 9.91s repeat logged 330/647 despite no visible defect and only 29.1ms worst frame. Its 15.3ms mean cadence exposes a ProMotion bug in the counter: it compares dynamically throttled callbacks against a possibly fixed 8.3ms `CADisplayLink.duration`. Fix the probe and remeasure the ≤2% scroll gate; do not treat the nominal 51.0% as app performance. |
| P0-4 | Android adapter clears the same bars | P0-1/2/3 equivalents on a minimal adapter, tested against GBoard + FUTO Keyboard + one OEM keyboard | E1 spike (landed 2026-07-11) | PARTIAL — adapter + conceal conformance + IME-guard harness green, live loop verified, zero divergences. 10k perf A/B (emulator): typing/open pass; **scroll fails (94.7% janky vs webview 3.8%) — iterate: needs viewport-scoped rendering, the same fix class iOS already applied**. Remaining: that fix + re-measure, live-keyboard composition (GBoard candidate bar, swipe), FUTO/OEM keyboard matrix, selection-handle torture over conceal |
| P0-5 | Widgets don't require markdown-in-Swift/Kotlin | One table + one inline image rendered AND edited per platform within a 2-day timebox each, semantics staying in the engine (D1 rule) | Extend POC scope; the >2k-line marker fallback UX counts here too | SPLIT — **Android PASS (2026-07-11)**: table grid + inline image via per-line ReplacementSpans, editing free via engine reveal, ~4h, D1 held (Evidence Log). iOS still open: table/image spike pending, plus the negative giant-note checkbox-fallback device evidence |
| P1-6 | Accessibility is fixable | Real-device VoiceOver pass BOTH editors; native needs a credible plan for marker-free reading + AX-exposed checkboxes (webview gets measured for the first time — it may be bad too) | Device pass + design note | **ITERATE — real-device A/B measured 2026-07-11.** CM6 has duplicate heading/no-role, swipe-focus, and continuous-reading defects, but task checkboxes expose correct label/role/state/action. Native exposes `#`/`**` markers, lacks heading semantics, and exposes task items only as raw punctuation/text with no checkbox semantics or toggle action. A now needs the promised credible marker-free reading + AX checkbox design before this can pass. |
| P1-7 | GPUI desktop has no >1-quarter gap | Daily-drive gpui app on real notes ≥3 days; gap list has nothing unshippable within a quarter (desktop IME, a11y, Wayland/Windows, packaging/updater) | Dogfood + gap log (extends the M8 audit) | PARTIAL — 10k A/B added first gap-list entries: X11-devel build deps on Wayland boxes, no headless-render path, unfocused-Wayland-surface never draws (probe-only concern?); 10k open/type/scroll/quit correct via real code paths. Dogfood + IME/a11y/packaging assessment still pending |
| P1-8 | Economics favor the winner | (a) Strand inventory both directions — A strands: Playwright/markdown-spec-runner/factory/agent-browser/MCP-bridge QA stack, CM6 itself. B strands: engine, gpui app, TextKit2 POC. (b) Retrospective: classify last ~3 months of editor/mobile bugs as seam-preventable / single-brain-preventable / neither | Analysis on main, no new code | **DATA COMPLETE (E6, 2026-07-12).** 3-month retrospective: SEAM 7 incidents/~20 commits/~1.5–2k lines vs SEMANTIC 5 incidents/~380 lines vs NEITHER 5 small — seam dominates ~4:1. **A structurally kills all 7 seam incidents; B's named focus/IME protocol prevents only 1 cleanly + 2 partially** — the rest (scroll ownership, embed-capability gating, openUrl/click-model bridge affordances) need an open-ended bridge-hardening program, so costing B off the one protocol understates it. Strands: A kills ~16–17k LOC (≈4.5k editor core + ≈8k QA scaffolding; YAML corpus and signed Tauri updater SURVIVE — desktop shell separable); B parks ~37–38k LOC already built and green (engine 16k, gpui 16k, mobile adapters ~5.6k). Judgment calls flagged in the E6 report (evidence log) |
| P2-9 | User-visible wins exist | Device: cold-open, keystroke latency, memory, battery — A should win somewhere users notice, else B's reversibility wins ties | Falls out of P0-3 probes | PARTIAL — iOS device: native p50 beat CM6, p95 slower (both inside P0-3); giant-note raw-checkbox fallback is a visible loss. Desktop 10k: CM6 carries a real typing-latency tail (p50 84ms keystroke→frame; 191ms p95 under the software-render path many Linux users actually get) while gpui's structural cost is ~1.8ms — potentially THE user-visible win for A, pending a focused-window measurement to confirm presented latency |

Decision rule: all P0 pass → A, with desktop (P1-7) allowed to lag mobile
in sequencing. Any P0 kill with no bounded fix → B, and the bridge
focus/IME state-machine proposal is executed instead. P1-8's strand
inventory sets the transition plan either way.

## 4. Experiments

Run in parallel where possible. Native-side work lives on
`poc/ios-textkit2-editor` (it has the reusable system: feature-gated pure
engine crates (P0), `export-spec` JSON corpus bin + `EditorEngine` UniFFI
surface (P1), Swift layer-2 harness (P2)). Analysis lives on main.

- **E1 — Android spike (highest information value; the long pole).**
  Branch `poc/android-editor` stacked on `poc/ios-textkit2-editor`.
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

- iOS kill-tests: directly on `poc/ios-textkit2-editor`. Android:
  `poc/android-editor` stacked on it. Decision artifacts (this doc, E6
  outputs, the final verdict): main, cherry-picked to the POC branch so
  Mac-side work has them.
- The POC branch trails main (based pre-Prettier, pre-isMobile-removal).
  Do NOT pay the merge tax during the spikes; if A wins, rebase/extraction
  is the first transition task.
- The losing path gets parked with a written verdict in `docs/learnings/`
  (same discipline as the factory parking) so this doesn't get relitigated
  in three months.

## 6. Verdict

*(Empty until every P0 row has data.)*
