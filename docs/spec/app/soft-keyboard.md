## Soft keyboard

- _(Android)_ Dismissing the soft keyboard by the system back gesture/button drops the
  focused field's caret, app-wide — Android hides the IME without clearing
  focus, and a caret with no keyboard has no function (#24). The drop is
  INSTANT: it keys off `imeAnimationTarget` (the hide animation's START),
  not the live IME inset (its end) — waiting out the slide-down reads as
  lag. The root `ClearFocusOnImeDismiss` covers every screen in the
  Activity window and clears focus from its native fields, including the editor;
  the editor ends its native selection interaction when focus leaves. A dialog
  hosting a text field installs its own
  (a Dialog is its own window with its own focus manager).
  → ui/components/ImeDismiss.kt, MainActivity.kt, NewFolderDialog.kt,
  CrashReportDialog.kt, EditorImeDismissBlurTest.kt
- _(Android)_ Focusing a dialog text field leaves the keyboard up until the user
  dismisses it. Every `ClearFocusOnImeDismiss` is passed IME visibility read
  in the ACTIVITY window (a dialog composable reads it in its function body),
  never its own window's — a dialog window's insets flicker as the keyboard
  opens, and a dialog-local reading closed it, making folder creation
  impossible (github#23). → ui/components/ImeDismiss.kt, DialogImeDismissTest.kt
- _(iOS)_ The hide key on an iPad's keyboard ends body editing as the toolbar chevron does: the native text view relinquishes first responder and its keyboard accessory leaves with the keyboard; no caret or selection handles remain on the unfocused note. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Toolbar.swift, apps/ios/Sources/Editor/TextFirst/TextFirstTextView.swift
- _(iOS)_ A native field (find or title) taking the keyboard over preserves the editor's selection, so find's current match survives the query-field handover and its Search key, and Previous or Next can continue stepping. → apps/ios/Sources/Editor/TextFirst/TextFirstFind.swift, apps/ios/Sources/Notes/Editor/TitleTextField.swift
- _(iOS)_ A temporary system presentation that hides the keyboard without ending the native text view's first-responder ownership leaves that ownership intact, so the keyboard can return on dismissal. → apps/ios/Sources/Editor/TextFirst/TextFirstTextView.swift
