## Soft keyboard

- _(Android)_ Dismissing the soft keyboard by the system back gesture/button drops the
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
- _(Android)_ Focusing a dialog text field leaves the keyboard up until the user
  dismisses it. Every `ClearFocusOnImeDismiss` is passed IME visibility read
  in the ACTIVITY window (a dialog composable reads it in its function body),
  never its own window's — a dialog window's insets flicker as the keyboard
  opens, and a dialog-local reading closed it, making folder creation
  impossible (github#23). → ui/components/ImeDismiss.kt, DialogImeDismissTest.kt
- _(iOS)_ The hide key on an iPad's keyboard ends the editing session as the
  chevron does (the bridge blur: the range collapses to its head, the table
  grips go, page focus goes), but only while the editor still holds page
  focus. It takes first responder from the web content but leaves the editor
  the page's focused element, which kept a long press selecting text instead
  of lifting a block. → EditorHost+KeyboardDismissal.swift
- _(iOS)_ A native field (find, title) taking the keyboard over drops only the
  editor's page focus and keeps its selection, so find's current match
  survives the find field's handover and its Search key, and the next
  Previous or Next moves off it. → EditorHost+KeyboardDismissal.swift
- _(iOS)_ A keyboard that hides while the web content keeps first responder
  (a share sheet over the editor) is left alone and comes back on its own.
  → EditorHost+KeyboardDismissal.swift
