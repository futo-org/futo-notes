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

## 3. Scorecard — criteria fixed in advance

P0 = kill criteria (A must pass every one). P1 = strong weight. P2 = tiebreak.

| # | Criterion | Threshold | How measured | Status |
| --- | --- | --- | --- | --- |
| P0-1 | iOS live IME correctness (device) | JP romaji composition (incl. candidate bar, mid-composition caret moves, reconversion), autocorrect, dictation, QuickPath swipe: zero dropped/duplicated/mangled text, zero divergence assertions | Device pass w/ console attached (POC verdict P3 "device-pending" rows) | PARTIAL — device/plain input persisted with zero divergence; live JP candidate/caret/reconversion, dictation, QuickPath, and boundary autocorrect remain pending |
| P0-2 | Selection/caret fidelity under conceal (device) | Cursor/motion fixture categories green through layer-2 harness; manual torture (tap into `**bold**`, handle-drag across concealed wikilink, double/triple-tap) at parity with CM6 side-by-side | Extend Swift layer-2 harness to motion cases + recorded manual A/B | PARTIAL — device tap/reveal, resolved-wikilink navigation, and double-tap word selection passed; handle-drag/triple-tap recorded A/B still pending |
| P0-3 | Large-note perf post-fix (device) | 10k note: open ≤1s, typing p95 ≤2× CM6 same device, scroll hitch ≤2%, no blank-viewport/caret-to-end bugs, memory sane | Re-run DevLatencyProbe device A/B (P5 said sim-only) | **PASS — iPhone 17 Pro device, 2026-07-10** (483.8ms setContent; native p95 67.7ms vs CM6 43.0ms; 0% native scroll hitch; 32.6MiB footprint; no persistence/caret/viewport/divergence failure) |
| P0-4 | Android adapter clears the same bars | P0-1/2/3 equivalents on a minimal adapter, tested against GBoard + FUTO Keyboard + one OEM keyboard | E1 spike (landed 2026-07-11) | PARTIAL — adapter + conceal conformance + IME-guard harness green on emulator, live loop verified, zero divergences (Evidence Log); remaining: live-keyboard composition (GBoard candidate bar, swipe), FUTO/OEM keyboard matrix, selection-handle torture over conceal, 10k-note perf leg |
| P0-5 | Widgets don't require markdown-in-Swift/Kotlin | One table + one inline image rendered AND edited per platform within a 2-day timebox each, semantics staying in the engine (D1 rule) | Extend POC scope; the >2k-line marker fallback UX counts here too | OPEN — negative device evidence: giant-note checkboxes visibly fall back to raw `- [ ]` markers; table/image spike still pending |
| P1-6 | Accessibility is fixable | Real-device VoiceOver pass BOTH editors; native needs a credible plan for marker-free reading + AX-exposed checkboxes (webview gets measured for the first time — it may be bad too) | Device pass + design note | OPEN |
| P1-7 | GPUI desktop has no >1-quarter gap | Daily-drive gpui app on real notes ≥3 days; gap list has nothing unshippable within a quarter (desktop IME, a11y, Wayland/Windows, packaging/updater) | Dogfood + gap log (extends the M8 audit) | OPEN |
| P1-8 | Economics favor the winner | (a) Strand inventory both directions — A strands: Playwright/markdown-spec-runner/factory/agent-browser/MCP-bridge QA stack, signed Tauri updater (M23), CM6 itself. B strands: engine, gpui app, TextKit2 POC. (b) Retrospective: classify last ~3 months of editor/mobile bugs as seam-preventable / single-brain-preventable / neither | Analysis on main, no new code | OPEN |
| P2-9 | User-visible wins exist | Device: cold-open, keystroke latency, memory, battery — A should win somewhere users notice, else B's reversibility wins ties | Falls out of P0-3 probes | PARTIAL — native p50 beat CM6 but p95 was slower (both inside P0-3); no decisive user-visible win yet, while raw giant-note checkbox markers are a visible loss |

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
