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

- `liveMarkdownTransform.ts`: `HorizontalRuleWidget.estimatedHeight = 50`
  (`HR_WIDGET_HEIGHT`); drop the inline margin/border styles.
- `markdown.css`: `.cm-md-hr-widget { height: 50px; display: flex;
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
