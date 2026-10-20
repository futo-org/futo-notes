## Soft keyboard _(Android)_

- Dismissing the soft keyboard by the system back gesture/button drops the
  focused field's caret, app-wide — Android hides the IME without clearing
  focus, and a caret with no keyboard has no function (#24). The drop is
  INSTANT: it keys off `imeAnimationTarget` (the hide animation's START),
  not the live IME inset (its end) — waiting out the slide-down reads as
  lag. The root `ClearFocusOnImeDismiss` covers every screen in the
  Activity window, and its `onDismiss` hook blurs the editor WebView over
  the bridge (its DOM caret survives a view-level clearFocus — see
  [editor.md](../editor.md)); a dialog hosting a text field installs its own
  (a Dialog is its own window with its own focus manager).
  → ui/components/ImeDismiss.kt, MainActivity.kt, NewFolderDialog.kt,
  CrashReportDialog.kt, EditorImeDismissBlurTest.kt
- Focusing a dialog text field leaves the keyboard up until the user
  dismisses it. Every `ClearFocusOnImeDismiss` is passed IME visibility read
  in the ACTIVITY window (a dialog composable reads it in its function body),
  never its own window's — a dialog window's insets flicker as the keyboard
  opens, and a dialog-local reading closed it, making folder creation
  impossible (github#23). → ui/components/ImeDismiss.kt, DialogImeDismissTest.kt
- iOS can't hit this: hiding the keyboard means resigning first responder,
  which drops the caret with it — the two are coupled on iOS, and the editor's
  only dismiss affordance (the toolbar chevron) blurs over the bridge.
