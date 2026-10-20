### Native toolbar chrome

- Native shells, toolbar chrome is NATIVE, commands are shared (bridge v3):
  the host renders its own toolbar from a GENERATED copy of the manifest and
  drives the editor over the bridge — `exec(id)` runs the shared command,
  the `cursorContext` and `formatState` messages drive Indent/Outdent visibility,
  `blur()`
  backs the dismiss chevron, and `setNativeToolbar(true)` suppresses the
  embed's web toolbar so two never show. `just toolbar-spec` regenerates the
  native specs; `just toolbar-spec-check` (part of `just check`) fails when
  one drifts from the manifest. → packages/editor/src/bridge.ts,
  scripts/gen-toolbar-spec.ts, tests/editor-embed-milkdown-toolbar.spec.ts
- iOS native: the toolbar is the keyboard's `inputAccessoryView` (generated
  ToolbarSpec.swift rendered by EditorToolbar.swift), replacing the stripped
  prev/next/Done bar — the system owns docking/animation with the keyboard.
  Original controls verified end-to-end on the iOS simulator 2026-06-10 (exec
  commands mutate the doc and autosave; Indent/Outdent appear inside a list or
  quote; pickers open natively; chevron blurs). → EditorToolbar.swift,
  EditorWebView.swift `futo_overrideInputAccessoryView`
- The toolbar band behind the buttons is the EDITOR's own background colour, so
  the bar reads as the bottom edge of the note rather than a strip pasted onto
  the keyboard. Nothing between the note and the band shows a colour step, in
  light or dark. _(native shells)_
- iOS native: the accessory is a `UIInputView` (`inputViewStyle` `.default`)
  painted `Theme.background`, and the buttons float on it in Liquid Glass
  capsules (`glassEffect` on iOS 26+, `.regularMaterial` below), one for the
  scrolling formatting items and one for the dismiss chevron, with no hairline
  behind the band. The system's `.keyboard` backdrop, used until 2026-09-23, is a
  translucent material that came out a near miss of the editor colour right
  where the two meet, a difference a user saw on a device. `Theme.surface`
  (#F2F2F2/#171717) before that was a visible slab. Apple's own accessory in
  Safari matches the PAGE behind it (242,242,247 on the iOS 26.5 simulator,
  2026-08-26), not the keyboard slab (223,224,230). → EditorToolbar.swift
  `FutoKeyboardAccessory`, `ToolbarMetrics`, `futoToolbarGlass`

- Android native: the bar and both of its edge fades paint `c.surface`, and so
  does the editor screen's `Scaffold`, which is what shows through the
  transparent editor page. The note and the band are therefore one colour by
  construction: #FFFFFF in light and #1F1C19 in dark, sampled on the pixels
  either side of the bar's top edge. A 1 dp `c.border` hairline marks that edge,
  where iOS deliberately draws none. Verified on the emulator (API 36)
  2026-09-23. → EditorToolbar.kt, NoteEditorScreen.kt `Scaffold`
  `containerColor`
- Android native: the toolbar is a Compose bar (generated ToolbarSpec.kt
  rendered by EditorToolbar.kt) docked above the soft keyboard via the editor
  screen's `imePadding`, shown only while the editor is focused (bridge
  `focus` message). Original controls verified end-to-end on the emulator
  2026-06-10 (exec commands mutate the doc and autosave; Indent/Outdent
  appear inside a list or quote; pickers open natively; chevron blurs,
  dropping keyboard + toolbar). → EditorToolbar.kt, NoteEditorScreen.kt,
  EditorWebView.kt `EditorHost`
- Native shells: the `cursorContext` bridge message carries `inContainer` —
  the caret is in a list item OR a blockquote — alongside the list-only
  `onListLine`, so Indent/Outdent show on BOTH native toolbars for a caret
  sitting in an existing blockquote, not only a list line. A host that has
  never seen the field (an older bundle) falls back to `onListLine`, the
  pre-fix behavior. → packages/editor/src/bridge.ts `CursorContextMessage`,
  MilkdownEditor.svelte `emitCursorContext`, EditorToolbar.swift,
  EditorToolbar.kt
- Android native: dismissing the soft keyboard by the system back
  gesture/button (not just the chevron) also blurs the editor — the caret
  and selection handle must not linger on screen with no keyboard (#24).
  The app-root `ClearFocusOnImeDismiss` ([app.md](../../app.md) "Soft keyboard")
  drops native-field focus, and its root install also blurs the editor over
  the bridge on the same IME visible→hidden transition — the editor's DOM
  caret survives a view-level clearFocus. (iOS can't hit this: keyboard and
  first-responder caret are coupled.) → MainActivity.kt,
  ui/components/ImeDismiss.kt, EditorImeDismissBlurTest.kt
- Dismissing the keyboard ends the editing session on the page, not only the
  keyboard: no caret, no highlighted text range, no cell selection, no
  selection handles, and no table row/column grips left where a tap put them.
  A bare DOM blur kept all of those. A selection survives a blur, and so do its
  decorations and handles. The grips come from the emulated mouse events a tap
  sends, and a tap never sends the `mouseleave` that would hide them. So the
  bridge `blur()` collapses the selection to its head, hides the grips, then
  blurs and clears the DOM selection. Every native dismissal goes through it:
  the chevron on both shells and Android's back-gesture dismissal. Desktop never
  calls it. On Android both dismissal paths clear a double-tapped word range
  (handles and callout included), the grips a tap showed, and the cell selection
  a grip menu leaves behind; tapping back in edits normally and brings the grips
  back. A touch drag across cells makes no cell selection on Android (Chromium
  sends a touch drag no mouse drag), so the grip menu is the touch route to one.
  Verified on the emulator (API 36, System WebView 133.0.6943.137) 2026-09-23.
  _(native shells)_ → src/features/editor/milkdown/hostHandleView.ts
  `blur`, src/features/editor/milkdown/table/tableGrips.ts `hideTableGrips`,
  tests/editor-embed-milkdown.spec.ts "blur() drops a highlighted range",
  tests/editor-embed-milkdown-table-grips.spec.ts "the bridge blur ends the
  table editing session"
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
    keyboard with no gap. → EditorToolbar.kt, NoteEditorScreen.kt
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
