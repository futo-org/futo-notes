### Native toolbar chrome

- Mobile toolbar items come from the generated shared manifest; native renderers dispatch them to Rust session commands and consume native toolbar state. → packages/editor/src/toolbar.ts, apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Toolbar.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstToolbar.kt
- iOS installs the toolbar as the text view's `inputAccessoryView`; UIKit owns its keyboard docking and animation. → apps/ios/Sources/Editor/Toolbar/EditorToolbarAccessory.swift, apps/ios/Sources/Editor/TextFirst/TextFirstTextView.swift

- The toolbar band behind the buttons is the EDITOR's own background color, so
  the bar reads as the bottom edge of the note rather than a strip pasted onto
  the keyboard. Nothing between the note and the band shows a color step, in
  light or dark. _(native shells)_
- iOS native: the accessory is a `UIInputView` (`inputViewStyle` `.default`)
  painted `Theme.background`, and the buttons float on it in Liquid Glass
  capsules (`glassEffect` on iOS 26+, `.regularMaterial` below), one for the
  scrolling formatting items and one for the dismiss chevron, with no hairline
  behind the band. The system's `.keyboard` backdrop, used until 2026-09-23, is a
  translucent material that came out a near miss of the editor color right
  where the two meet, a difference a user saw on a device. `Theme.surface`
  (#F2F2F2/#171717) before that was a visible slab. Apple's own accessory in
  Safari matches the PAGE behind it (242,242,247 on the iOS 26.5 simulator,
  2026-08-26), not the keyboard slab (223,224,230). → EditorToolbar.swift
  `FutoKeyboardAccessory`, `ToolbarMetrics`, `futoToolbarGlass`

- Android native: the bar and both of its edge fades paint `c.surface`, and so
  does the editor screen's `Scaffold`, which is what shows through the
  native editor view. The note and the band are therefore one color by
  construction: #FFFFFF in light and #1F1C19 in dark, sampled on the pixels
  either side of the bar's top edge. A 1 dp `c.border` hairline marks that edge,
  where iOS deliberately draws none. Verified on the emulator (API 36)
  2026-09-23. → EditorToolbar.kt, TextFirstEditorScreen.kt `Scaffold`
  `containerColor`
- Android native: the toolbar is a Compose bar (generated ToolbarSpec.kt
  rendered by EditorToolbar.kt) docked above the soft keyboard via the editor
  screen's `imePadding`, shown while the native editor is focused and the IME is visible. Original controls verified end-to-end on the emulator
  2026-06-10 (exec commands mutate the doc and autosave; Indent/Outdent
  appear inside a list or quote; pickers open natively; chevron blurs,
  dropping keyboard + toolbar). → EditorToolbar.kt, TextFirstEditorScreen.kt,
  TextFirstToolbar.kt
- Android: dismissing the soft keyboard with the system back gesture/button or the toolbar chevron clears native editor focus; caret, selection handles and the text-action menu disappear. The app-root `ClearFocusOnImeDismiss` handles the IME visible→hidden transition, and the native text view ends the range without scrolling the reader away from their line. → apps/android/app/src/main/java/com/futo/notes/ui/components/ImeDismiss.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditTextReveal.kt `endSelectionOnBlur`
- Mobile: keyboard dismissal ends visible editing affordances through the platform text view. Tapping the note again restores native editing and the keyboard toolbar. iOS resigns the text view's first-responder status; Android hides the IME and clears text-view focus. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Toolbar.swift, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstToolbar.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditText.kt
- **Toolbar docking + height (both native shells).** The bar is exactly
  **44 pt** tall on iOS / **44 dp** on Android, its 36 pt/dp icons centered
  with ~4 pt top/bottom, and it sits **FLUSH against the top of the on-screen
  keyboard**: there is NO empty band between the toolbar icons and the
  keyboard's first row. Verified on the iOS simulator with the soft keyboard
  up 2026-06-18.
  - iOS is fragile here: as a keyboard `inputAccessoryView` hosted in a
    `UIHostingController`, the default behavior feeds the keyboard window's
    bottom safe-area (home-indicator, ~34 pt) inset into the hosted SwiftUI
    content, which pushes the icons up and opens a dead band below them. The
    flush dock is held by `ToolbarMetrics.barHeight` (single source for the
    44 pt across the SwiftUI frame, the container frame, and
    `intrinsicContentSize`) plus `UIHostingController.safeAreaRegions = []`.
    Do not remove the `safeAreaRegions` line, and re-check the simulator with
    the keyboard up after touching the accessory. This gap regressed in
    7c43a8e (web `visualViewport`-docked toolbar → native bar) and was
    re-closed 2026-06-18. → EditorToolbar.swift `ToolbarMetrics`,
    `EditorToolbarAccessory`
  - Android docks flush by construction: the 44 dp Compose bar is held above
    the keyboard by the screen's `imePadding`, so the inset tracks the
    keyboard with no gap. → EditorToolbar.kt, TextFirstEditorScreen.kt
- **Scroll affordance — "snapped peek" (both native shells).** When the items
  overflow, the trailing edge does NOT cut cleanly (which read as "nothing more
  here"): the bar measures the laid-out button positions + the viewport width
  and adds a trailing inset that clips whichever icon sits at the edge to ~55%,
  so a partial icon always peeks past the edge — the deterministic, same-on-
  every-width/density signal that the bar scrolls. A soft ~10 pt edge fade
  softens the clipped icon (and the leading edge once scrolled). Verified on the
  iOS simulator (iPhone 17 Pro 402 pt + Pro Max 440 pt) and the Android emulator
  2026-06-30 — a different edge icon is clipped per width, always to ~half. iOS
  measures the outer slot independently of scroll offset; Android from
  `onGloballyPositioned` (`positionInWindow`) + a measure-tick. → EditorToolbar.swift
  `computeSnap`, EditorToolbar.kt `computeToolbarSnapPx`
- _(iOS)_ Scrolling or bouncing at either toolbar edge never changes its viewport
  width; the peek inset follows only the outer slot, button layout, and display
  scale. Edge fades animate independently, preserving native scroll bounce. →
  EditorToolbar.swift, EditorToolbarLayoutTests.swift
- Camera inserts a photo from the device camera or photo library; Image opens
  a file picker. Both save the image into the vault and insert `![](file)`.
  On the native shells the toolbar's Camera/Image buttons reach the host
  picker (web toolbar posts `pickImage`; the native iOS/Android toolbars
  invoke it directly), which presents the native picker (Photo Picker / camera intent
  on Android; PHPicker on iOS, camera falling back to the library on the
  simulator), saves the bytes into the vault root under a generated
  space-free name, and calls `insertImage` back into the embed.
- _(Android)_ Camera asks for the `CAMERA` permission at the moment of use,
  because the manifest declares it for pairing and Android then refuses the
  camera intent without it. Granted, the system camera opens; a first refusal
  leaves the note as it was with a toast saying why; a final refusal shows a
  "camera access is off" dialog with Open Settings. A tap never crashes the
  app, including after the permission is revoked. → ImagePicker.kt
  `captureCamera`, AppSettings.kt
