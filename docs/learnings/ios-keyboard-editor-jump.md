# iOS Keyboard Editor Jump

## Summary

Two iPhone editor symptoms looked related because they both happened around the
software keyboard, but they had different causes:

- Pressing Enter in a continued list item did not scroll the new item into view
  because our custom list-continuation handler bypassed CodeMirror's default
  `scrollIntoView` transaction behavior.
- Tapping into a tall note could make the whole app appear to jump while the
  keyboard opened because iOS WKWebView was doing native contenteditable focus
  scrolling during keyboard presentation.

The stable fix was to avoid the native iOS contenteditable tap-focus path only
for the first tap that opens the editor: resolve the tapped CodeMirror line on
`touchend`, focus with `preventScroll`, then set the CodeMirror selection.

## What Was Misleading

`visualViewport.offsetTop` briefly spiked during the jump, so it was tempting to
compensate with a CSS translate. That made probe data look correct at `rAF`
sampling time, but the visible motion remained. The likely reason is that the
WKWebView keyboard/viewport animation is partly compositor-driven and its
intermediate visual state is not fully visible to main-thread JavaScript.

Attempts to translate the app in lockstep with `visualViewport.offsetTop` either
lagged or got ahead of the compositor animation. They also risked fighting the
drawer transform and the fixed markdown toolbar.

Focusing on `touchstart` was also wrong. It suppressed some jump behavior, but
it caused scroll gestures to place the cursor because the editor was focused
before the gesture had proven itself to be a tap.

## Final Shape

The final iOS-specific tap path is intentionally narrow:

- It runs only on iOS.
- It records a one-finger `touchstart`.
- It ignores the gesture if movement exceeds a small tap threshold.
- It acts only on `touchend`, after the gesture is known to be a tap.
- It does nothing if the editor is already focused.
- It requires a concrete `.cm-line` hit. If the tapped line cannot be resolved,
  it lets the native event path continue instead of guessing position 0.
- It focuses `contentDOM` with `{ preventScroll: true }`.
- It dispatches the CodeMirror selection after focus, because WebKit focus can
  install its own contenteditable selection.

The companion keyboard inset fix keeps `keyboard.offsetTop` at `0` on iOS so
transient `visualViewport.offsetTop` spikes cannot move the floating chrome.

The list-continuation fix adds `scrollIntoView: true` to every custom Enter
dispatch in `handleEnter`, matching CodeMirror's normal Enter behavior.

## Test Coverage

The focused regression tests cover:

- iOS tap focus sets the requested selection and focuses with `preventScroll`.
- Unresolved taps are not intercepted.
- Scroll gestures are not converted into cursor placement.
- Disabled/non-iOS wiring is a no-op.
- Existing list-continuation and keyboard state behavior still pass.

Device testing is still required for this class of issue. Browser/jsdom tests can
prove the event gating and transaction ordering, but they cannot reproduce iOS
WKWebView's keyboard and visual viewport timing.

