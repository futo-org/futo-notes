#### Block drag: autoscroll, release and touch suspension

- A block drag holding the pointer within 64px of the editor scroller's top or
  bottom edge scrolls the note continuously — 200px/s at the zone's inner lip
  ramping to 1400px/s at the edge — so a block can be dropped at a boundary that
  was off screen when it was lifted. It runs while the pointer holds still, stops
  at the document's ends, and stops on every exit (commit, no-op release, cancel,
  editor destroy). The drop slot is recomputed each frame from the boundary
  now under the stationary pointer. Both drag paths share it: the native shells'
  long-press drag and the desktop ⠿ gutter handle's mouse drag. Verified on an
  Android device 2026-09-01 — a hold within the zone scrolls continuously and
  stops on release; a hold mid-viewport does not scroll. →
  src/features/editor/milkdown/blockDragGeometry.ts `createDragAutoScroller`,
  src/features/editor/milkdown/blockDragSession.ts,
  src/features/editor/milkdown/blockDragGeometry.test.ts,
  tests/editor-embed-milkdown.spec.ts _(native shells)_
- Dropping a top-level block never scrolls the note: the blocks on screen at the
  release stay exactly where the live preview drew them, and the dropped block
  lands where the preview showed it — also when edge auto-scroll carried the
  source block off the top of the screen before the drop (Chromium's scroll
  anchoring used to pull the view back by the source's height then), and also
  when the move makes the note shorter while it is scrolled to its bottom (a
  last paragraph moved above a first heading loses one paragraph gap; the
  browser used to clamp the scroll position to the shorter note and move every
  block down). For that, the editor holds the missing scroll extent (a
  transparent bottom border, apart from its own bottom padding, which keeps
  following the window size) until the first scroll, or the first change of
  its blocks such as opening another note, that leaves the view clear of it, so
  its removal never moves the view either, even after the window was resized.
  Verified in Chromium (Playwright) 2026-10-08. →
  src/features/editor/milkdown/blockDragCurtain.ts `holdScrollThroughDrop`
  `holdScrollExtent`, src/features/editor/milkdown/blockDragSession.ts,
  tests/editor-embed-milkdown.spec.ts
- Only the dropped block moves at the release, snapping into its slot: a
  neighbour still sliding out of the way when the finger lifts finishes its
  slide, and the move is committed (and the note reported changed) once the
  slides end, at most ~0.18s later. A scroll or a layout change in that time (a
  resized window, an image loading) commits it at once, which is a relayout of
  the screen anyway; an edit elsewhere commits it at once, mapped through the
  edit; a change that takes the block away (another note opened) cancels it,
  and the new note shows at once; the editor going away cancels it. No new drag
  lifts until it has committed. Verified in Chromium (Playwright) 2026-10-09. →
  src/features/editor/milkdown/blockDragSession.ts `land`,
  src/features/editor/milkdown/blockDragCurtain.ts `land`,
  tests/editor-embed-milkdown.spec.ts
- A finger landing on a block in the long-press block drag suspends the
  platform's DELAYED text interaction from touch-down — the magnifier loupe and
  tap-and-a-half select — for as long as the press lasts, and restores it the
  moment the press resolves, however it resolves (lift, tap, scroll, cancel). It
  is requested at touch-down and not at the lift because the platform gesture
  fires at ~655ms with the editable focused and ~700ms unfocused, against the
  340ms lift: a press that produced no lift for any reason used to hand the user
  the magnifier and a word selection with nothing suspended at all. Measured on
  the simulator 2026-09-01. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  apps/ios/Sources/Editor/EditorWebView.swift `delayedTextInteractionGestures`,
  packages/editor/src/bridge.ts `BlockPressMessage`,
  tests/editor-embed-milkdown.spec.ts _(native shells, iOS)_
- A tap still places the caret and raises the keyboard, and a double-tap still
  selects a word and shows the platform Cut/Copy/Paste callout, during and after
  that press-level suspension: only the hold-triggered recognisers stand down,
  never the tap ones. An ordinary swipe scrolls and never lifts a block.
  Verified on the simulator 2026-09-01 and on an Android device 2026-09-01. →
  apps/ios/Sources/Editor/EditorWebView.swift `delayedTextInteractionGestures`,
  apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt
  `setBlockPressActive` _(native shells)_
- While a block is airborne in that drag, the suspension escalates to the WHOLE
  platform text interaction — no magnifier over the block being moved, no
  callout, no caret dragged along behind it, and the selection preference off —
  and steps back down the moment the gesture resolves, however it resolves.
  Nothing on the page can suppress it, so the editor reports both the press and
  the drag over the bridge and the shell decides what each means. Verified on the
  simulator 2026-09-01. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  apps/ios/Sources/Editor/EditorWebView.swift `applyTextInteractionLevel`,
  packages/editor/src/bridge.ts `BlockDragMessage`
  _(native shells, iOS)_
- Moving an airborne block sideways never starts a back-swipe, and a block is
  never left lifted once the finger is up. On iOS 26+ the navigation
  controller's content pop takes a horizontal drag from anywhere on screen, so
  it used to win a sideways block move: the editor started sliding away, and the
  page never heard the touch end, which left the block stuck in its lifted state
  with no finger on it. The airborne suspension therefore also disables the
  interactive pop recognisers (the leading-edge swipe and the full-width content
  swipe) and restores them when the gesture resolves. Android needs nothing
  extra: its back gesture only starts at the screen edge, so a drag that began
  mid-screen is never taken for one, even when the lifted block is carried to
  either edge and held there. A touch the platform cancels (an injected
  `ACTION_CANCEL`, or the notification shade pulled down mid-drag) drops the
  block too. Verified on the emulator with gesture navigation (API 36, System
  WebView 133.0.6943.137) 2026-09-23, on a fresh one-block note and a
  five-block one. → apps/ios/Sources/Editor/EditorWebView.swift
  `navigationPopGestures`, src/features/editor/milkdown/mobileBlockDnd.ts
  `onPointerCancel` _(native shells)_
