# Horizontal-Rule Scroll Jank (iOS)

## Symptom

A long note containing a `---` horizontal rule scrolled jankily on iPhone —
the content "jumped around" mid-scroll. Reproduced on the native iOS shell
(`com.futo.notes` / `.dev`) with `FUTO Hosted LLM Pitch.md`.

## Root cause

The editor (`MarkdownEditor.svelte` → CodeMirror 6) runs in CM6's **native
fixed-height scroller** on iOS (`.cm-scroller` owns scrolling; see
`editor.html`). The external scroll-compensation path in `MarkdownEditor.svelte`
is **off** there — the embed mounts the editor with no `scrollParent`, so the
`compensating`/`anchorPos` logic never runs. So this jank was not the
compensation code.

CM6 sizes any line that is currently scrolled out of view from an **estimated**
height (a `HeightMapGap`). For a line replaced by a widget, that estimate comes
from the widget's `estimatedHeight` getter — **not** the height oracle (so
forcing a full document parse/measure on load does *not* fix it; verified
empirically).

`HorizontalRuleWidget.estimatedHeight` returned **18**, but the widget actually
rendered a **~50px** footprint (`.cm-md-hr-widget { margin: 16px 0 }` = 32px
plus the inner rule's box). The moment the rule scrolled back into CM6's
measured range, CM corrected the gap by ~32px and adjusted `scrollTop` to keep
its anchor — which, during iOS momentum scrolling, is a visible jerk.

## Measurement

Injected a scroll probe into the bundled `editor.html` (the iOS WebView is
`isInspectable` but `ios_webkit_debug_proxy` could not bind the simulator) that
tracks `.cm-scroller.scrollTop` per frame and counts direction reversals.
Hot-swapping just `editor.html` into the installed `.app` (no Xcode/Rust
rebuild) gave a fast measure loop.

| Scenario | worst reversal (`maxRev`) |
|---|---|
| With `---`, before fix | up to **235px** |
| `---` removed | ~31px |
| Full-document premeasure (oracle calibration) | still ~142px — **no help** (widget estimate, not oracle) |
| With `---`, after fix | ~29px (== the no-HR floor) |
| After fix, slow/normal scroll | **0 reversals, maxFrame 4px** |

The ~30px residual on hard flings is CM6's inherent wrapped-line gap estimation
(present with or without the rule) and is not visible at normal scroll speeds.

## Fix

Make the widget's measured height **exactly equal** its `estimatedHeight`, and
make that height **deterministic** (no margins, which can collapse against the
adjacent line and make measured ≠ estimated):

- `live-preview/widgets.ts`: `HorizontalRuleWidget.estimatedHeight = 50`
  (`HR_WIDGET_HEIGHT`); drop the inline margin/border styles.
- `markdown-blocks.css`: `.cm-md-hr-widget { height: 50px; display: flex;
  align-items: center }` with the rule on the inner `> div`.

## Guard

`tests/markdown-rendering.spec.ts` → "horizontal rule rendered height matches
its CM6 estimate" asserts the rendered `.cm-md-hr-widget` is 50px. If the CSS
height and `estimatedHeight` ever drift apart, the bug re-opens.

## General principle

Any CM6 **replace widget** (HR, image, table, code-fence label) must report an
`estimatedHeight` equal to its real rendered footprint, and should render at a
**definite** height so the two cannot drift. A wrong widget estimate is a
scroll-jump waiting to happen the next time that element scrolls into view.

## Update (2026-06-17): two more causes of the same jump

The HR fix removed the widget-driven jump, but the note still "jumped around"
on a physical iPhone. Two more contributors, same mechanism (CM6 measures a
line whose height differed from its estimate → `scroll.scrollTop += diff` to
re-pin the scroll anchor → a visible jolt on a touch-momentum scroller):

1. **Font swap (FOUT) — the big one.** The editor uses Barlow with
   `font-display: swap`. The native editor WebView is **prewarmed empty**, so
   Barlow only begins decoding when the first note's text renders — then swaps
   in mid-view, changing every line's metrics at once → one large (~200px)
   correction during the first scroll. Intermittent: it only bites while the
   OS/WebKit font cache is cold (a warm cache decodes Barlow before the scroll,
   so no swap — which is why it reproduced on early launches but not later).
   **Fix:** `src/editor-embed/main.ts` `warmEditorFonts()` eagerly
   `document.fonts.load(...)`s every Barlow weight at editor startup (during
   prewarm, before content), then re-measures on completion. The editor now
   measures in Barlow from the first frame — no swap, no correction.

2. **Proportional-font wrapped-line estimation — the residual.** CM6 estimates
   each off-screen line at ~1 line-height; a paragraph that **wraps** to N visual
   lines in a proportional font is under-estimated by ~(N-1) line-heights. When
   it scrolls into the measured range CM6 measures it taller, grows the height
   map, and writes `scrollDOM.scrollTop += diff` to re-pin its anchor.

The earlier `scrollJumpGuard` mitigation for #2 was **wrong twice over** and has
been removed:

- It only reverted *reversals* (`nd !== dir`). The actual user-reported jank is a
  **forward** correction — a long paragraph above/at the fold measures taller, so
  the anchor moves *down* and `diff > 0` *while scrolling down*. Same direction as
  the scroll → the guard never fired.
- Worse, the guard *itself* wrote `scrollTop` mid-scroll. On iOS, **any**
  programmatic `scrollTop` write cancels the in-flight touch momentum — so the
  guard (and CM6's own correction) made the scroll "jump forward and **stop**,"
  with no bounce. That exact triple — jump forward, dead-stop, no bounce, worse
  on harder flicks — is the signature of a momentum-killing scroll write.

## Update (2026-06-17, later): the real fix — warm the height map

The premise "CM6 re-gaps far-away lines so premeasure doesn't help" was **false**.
Reading `@codemirror/view` source: a measured line (`HeightMapText`) keeps its
height and is *only* reverted to an estimate when the **document** changes that
range (`HeightMapText.updateHeight` re-estimates only if `force || outdated`;
`applyChanges` rebuilds only edited ranges). Scrolling away never re-gaps. So the
height map is **monotonically accurate** once measured — and there is no facet to
disable the anchor correction (the `scroll.scrollTop += diff` write is gated only
on a touch within the last 100ms, always true mid-flick).

**Fix:** `src/features/editor/heightMapWarm.ts` `warmHeightMap(view)` walks the viewport
across the whole doc once, measuring every line's real height up front. It moves
the viewport with CM6's OWN `EditorView.scrollIntoView(pos, {y:'start'})` (NOT a
raw `scrollDOM.scrollTop` write) and forces a synchronous `view.measure()` after
each step. Using `scrollIntoView` matters: a fresh load pins the scroll anchor
near the top, so a raw `scrollTop` write is reverted on the next measure (the very
anchor correction we're fighting) and the viewport never actually moves —
`scrollIntoView` re-targets the anchor so it sticks. Because measured heights
persist, the anchor `diff` is then ~0 forever after and the momentum-killing write
never executes. `MarkdownEditor.svelte` runs it when `nativeShell` identifies
the native embed (where CM6 owns its scroller), after every full-load
`setContent`, after Barlow finishes decoding (font swap re-flows metrics), and
on any scroller **width** change (rotation / resize re-flows wrapping — the only
non-edit invalidation). `MarkdownEditor.warmScroll()` exposes it, and the editor
embed exposes `window.__scrollDiag()` for probes.

Bounce restored too: `.cm-scroller` went from `overscroll-behavior: none` (only
there to keep the deleted guard's "a big reversal must be a correction" premise
clean) back to `contain` — native overscroll affordance (iOS rubber-band bounce /
Android edge stretch), no scroll-chaining to the host. Unit-tested in
`src/features/editor/heightMapWarm.test.ts`.

## This bug is CROSS-PLATFORM (iOS **and** Android) — confirmed 2026-06-17

iOS and Android native shells run the **same** `editor.html` bundle in a
prewarmed, app-lifetime WebView where **CM6 owns its own scroller**. So the bug,
and the fix, are identical on both — there is no platform-specific scroll code to
write. Only the *magnitude* differs, because it's driven by each engine's font
metrics. Measured with a real-fling correction counter (hook the scroller's
`scrollTop` SETTER — native momentum updates scrollTop internally and bypasses the
JS setter, so any JS write *during* a fling is necessarily a CM6 correction):

| Platform | warm OFF (baseline) | warm ON (fixed) |
|---|---|---|
| iOS simulator | 2 corrections, max ~200px | **0** |
| Android emulator (Chromium WebView) | **7 corrections, max 1436px** | **0** |

On Android the cold height map under-estimated the doc by ~700px (9525 → 10247px
after warming), producing a single **1436px** correction mid-fling — a violent
jump. Warming drove it to **zero corrections across the whole doc** on both.

The fix reaches Android automatically because `apps/android/run.sh` rebuilds the
editor bundle and `cp`s it into `app/src/main/assets/editor.html` (gitignored).
A STALE staged asset will silently ship the old behavior — if Android still janks
after an editor change, confirm the asset was re-staged.

## For future models: triaging "the editor scrolls janky on mobile"

This is a recurring trap. Internalize these:

1. **It's the WebView editor (CM6), not native scroll code.** Both mobile shells
   embed the shared web editor; native scroll containers aren't involved.
2. **"Jumps and stops, no bounce, worse on harder flicks" == a programmatic
   `scrollTop` write killing native momentum.** On iOS *and* Android Chromium
   WebView, ANY JS write to a scroller's `scrollTop` during an active touch/fling
   cancels the in-flight momentum. Never write `scrollTop` mid-scroll. The dead
   `scrollJumpGuard` violated this — don't reintroduce that pattern.
3. **The root trigger is CM6's height-map ESTIMATE for off-screen wrapped lines.**
   It under-estimates proportional-font wrapped paragraphs; on first scroll-in CM6
   re-measures and writes `scrollTop += diff` to keep its anchor. There is no facet
   to disable that write.
4. **The fix is to make the estimate moot: warm the whole height map up front.**
   Measured heights persist (CM6 only re-gaps on a *document edit*), so one walk
   per load/width-change/font-load is durable. Move the viewport with
   `scrollIntoView`, not `scrollTop`. Re-warm on anything that re-flows wrap width.
5. **Measure with the `scrollTop`-setter hook + real flings**, not `grew` (total
   scrollHeight delta). Corrections are driven by *local* re-measurement near the
   scroll position and can be huge (1436px) even when the whole-doc total nets to
   ~0 — so a "grew ≈ 0" reading does NOT mean "no jank." Count the setter writes
   during an actual fling.
6. **Android can run JS in the WebView via CDP; the iOS simulator cannot.** On
   Android: forward `webview_devtools_remote_<pid>` and use `scripts/cdp-invoke.mjs`.
   On the iOS sim: hot-swap an instrumented `editor.html` into the installed `.app`
   and read a DOM overlay via screenshots (a planned fuller write-up,
   `ios-editor-hotswap-and-scroll-probe`, was never landed — this summary is the
   only description of the technique). Drive real flings
   with `adb shell input swipe` / the simulator's `ui_swipe`.
