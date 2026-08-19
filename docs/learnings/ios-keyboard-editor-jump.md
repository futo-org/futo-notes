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

The stable fix was to give iOS one qualified `touchend` path for first-tap focus
and off-text placement. On-text taps in an unfocused editor focus with
`preventScroll` before setting the selection; off-text taps resolve against a
non-editable scroller tail that WebKit cannot overwrite afterward.

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

Keeping the blank tail inside `contenteditable` was also unstable. Our handler
could place the correct caret, but WebKit then installed its own DOM selection at
the note end and CodeMirror imported it, producing a visible jump. The tail now
belongs to the scroller, outside `contenteditable`, and contributes overflow
after both short and long notes so it remains draggable and the final line can
clear the keyboard.

Android needs a different owner. Preventing its native on-text tap suppresses
the IME, while CodeMirror ignores mouse-selection hooks briefly after touch.
Android therefore keeps the native tap, corrects on-text placement on `click`,
and uses the synthesized compatibility `mousedown` for off-text placement.

These policies are selected from the host-provided `nativeShell` mode plus iOS
platform detection. User-agent and touch-capability signals can identify iOS,
but they cannot say whether the editor is running in a native shell; using them
as the native-mode authority previously disabled required focus paths in
embedded editors.

## Final Shape

The final iOS-specific tap path is intentionally narrow:

- It runs for the iOS browser and native-iOS profiles.
- It records a one-finger `touchstart`.
- It ignores the gesture if movement exceeds a small tap threshold.
- It acts only on `touchend`, after the gesture is known to be a tap.
- Focused on-text taps remain native.
- An unfocused on-text tap resolves a concrete `.cm-line`, focuses `contentDOM`
  with `{ preventScroll: true }`, then dispatches the CodeMirror selection.
- An off-text tap resolves against the shared near/far geometry whether focused
  or unfocused; double-tap seeds a word and triple-tap seeds a paragraph.
- Moved, cancelled, multitouch, interactive-overlay, and unresolved gestures
  remain on their native path.

The companion keyboard inset fix keeps `keyboard.offsetTop` at `0` on iOS so
transient `visualViewport.offsetTop` spikes cannot move the floating chrome.

The list-continuation fix adds `scrollIntoView: true` to every custom Enter
dispatch in `handleEnter`, matching CodeMirror's normal Enter behavior.

## Test Coverage

The focused regression tests cover:

- iOS on-text focus sets the requested selection with `preventScroll`.
- iOS off-text single/double/triple placement and short/long tail scrolling.
- Scroll, cancelled, multitouch, interactive-overlay, and unresolved gestures
  are not converted into cursor placement.
- Android native focus, on-text correction, off-text compatibility events, and
  modified/multi-tap pass-through.
- Existing list-continuation and keyboard state behavior still pass.

Device testing is still required for this class of issue. Browser/jsdom tests can
prove the event gating and transaction ordering, but they cannot reproduce iOS
WKWebView's keyboard and visual viewport timing.
