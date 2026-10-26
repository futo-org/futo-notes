#### Block drag: lifting and drop slots

- Both native shells drag a block by LONG-PRESSING THE BLOCK ITSELF — there is
  no ⠿ handle anywhere in the editor on a phone, and the left gutter that would
  hold one is not reserved. Touch and hold a block for ~340ms and it lifts as a
  card-like ghost under the finger, dragging floats it with the drop previewed
  at the resolved top-level boundary, and release commits the move. The ⠿
  gutter handle is the DESKTOP gesture only. Verified on an Android
  device 2026-09-01 (moto g play 2023, System WebView 151) and on the iOS
  simulator. → src/features/editor/milkdown/blockDragMode.ts
  `resolveBlockDragMode`, src/features/editor/milkdown/mobileBlockDnd.ts,
  src/features/editor/milkdown/blockDragMode.test.ts
  _(native shells)_
- Editor focus arbitrates block drag against text selection on both native
  shells: a press that starts with the editor already focused (soft keyboard
  up) is left completely alone — text selection and caret placement, exactly
  as if this plugin did not exist — and a press that starts with the editor
  unfocused (keyboard down) arms and may lift a block, as above. Before this,
  every press suppressed selection rendering and armed the lift timer
  regardless of focus, so a phone's long-press-to-select-a-word was always
  read as "lift this block" instead — reported by QA on the 1.7.2-4 builds.
  Checked once, at touch-down; a press already in flight does not re-arbitrate
  mid-gesture. → src/features/editor/milkdown/mobileBlockDnd.ts
  `onPointerDown`, src/features/editor/milkdown/mobileBlockDnd.test.ts,
  tests/editor-embed-milkdown-long-press.spec.ts _(native shells)_
- The lifted ghost shows the WHOLE block from its very first frame, sits over
  the block it was lifted from (padded by the card's own breathing room, so it
  reads against the drop-indicator line, which is drawn in viewport space), and
  is capped at 40% of the screen height — only a block that genuinely exceeds
  the cap is cropped, and that crop fades out rather than cutting off. The
  card must never carry a `vh` height cap: both native hosts' web view
  resolves viewport units against a zero-height containing block, so `40vh`
  came out as `0px` and the card collapsed to its own padding. The cap is
  therefore computed in pixels from `window.innerHeight`. Verified on the pool
  emulator 2026-09-03 (Android 16, Chromium 133 WebView). (Until 2026-09-05 the
  card also had to shed the editor's offscreen-block containment rule, which
  cropped it to one unrendered line on Android; that rule is gone — see
  Performance.) →
  src/features/editor/milkdown/blockDragVisuals.ts `createGhost`
  `GHOST_MAX_HEIGHT_FRACTION`, tests/editor-embed-milkdown-drag-ghost.spec.ts
  _(native shells)_
- On desktop a ⠿ handle appears in the left gutter beside the top-level block
  under the pointer — in the GUTTER, 4px left of the text column, never over a
  list marker, and beside the block's first line. Hovering anywhere inside a
  list, at any depth, surfaces the handle for the whole list, beside its first
  item — and dragging it with a mouse reorders blocks. Where there is no
  hover, the handle is still surfaced for the block that was just tapped or
  that the caret moved into, but dragging it needs a mouse: the drag starts on
  a mouse's primary-button press and no touch or pen gesture starts it. →
  src/features/editor/milkdown/blockDrag.svelte.ts,
  src/features/editor/milkdown/handleBlockDrag.ts,
  src/features/editor/milkdown/blockMove.ts _(desktop)_
- The desktop ⠿ handle's drag is POINTER-DRIVEN, never the browser's HTML5
  drag: @milkdown/plugin-block still renders, positions and hover-tracks the
  handle, but its own drag (`draggable`, `dragstart`, `setDragImage`) is cut
  off before it can start, so no OS drag image is ever drawn on any platform.
  Pressing the handle and moving the pointer a few pixels lifts the block
  through the same drag the native long press uses after its lift; a click that
  does not move changes neither the note nor the selection, and Escape
  mid-drag cancels with no transaction. The handle is hidden for the length of
  the lift. → src/features/editor/milkdown/handleBlockDrag.ts,
  src/features/editor/milkdown/handleBlockDrag.test.ts,
  src/features/editor/milkdown/blockDragSession.ts,
  tests/editor-embed-milkdown-gutter-handle.spec.ts _(desktop)_
- While the desktop ⠿ handle has a block lifted, the pointer is the grabbing
  cursor everywhere in the window, and the mouse wheel still scrolls the note
  under the pointer. → src/features/editor/milkdown/handleBlockDrag.ts
  `showCursorLayer`, tests/editor-embed-milkdown-gutter-handle.spec.ts _(desktop)_
- A block drag only ever lifts a TOP-LEVEL block, on both gestures. A press
  anywhere inside a list — bullet, ordered or task, at any nesting depth —
  lifts the WHOLE top-level list as one block, and the same goes for anything
  nested inside another top-level block, such as a blockquote. A single list
  item cannot be dragged on its own. So every drag gets the same live-reflow
  preview: the other blocks slide out of the way and the dimmed source sits in
  its landing slot, rather than some drags drawing a drop line instead. (List
  items used to drag on their own within their list, with only the line,
  because the preview handles top-level blocks only; a drag flipped between the
  two depending on what was grabbed.) → src/features/editor/milkdown/mobileBlockDnd.ts
  `onPointerDown`, src/features/editor/milkdown/handleSource.ts `handleSourceFor`,
  src/features/editor/milkdown/blockDragCurtain.ts,
  src/features/editor/milkdown/handleSource.test.ts, tests/editor-embed-milkdown-gutter-handle.spec.ts
- A dragged block only lands in a gap between top-level blocks: just below a
  blockquote is NOT "inside the blockquote", however the schema would read that
  position, and a point between two items of a list is the gap above or below
  the whole list. → src/features/editor/milkdown/blockDragGeometry.ts
  `resolveDropTarget`, src/features/editor/milkdown/blockMove.ts `moveBlock`,
  src/features/editor/milkdown/blockDragGeometry.test.ts,
  src/features/editor/milkdown/blockMove.test.ts, tests/editor-embed-milkdown-gutter-handle.spec.ts
- The drop line is the fallback when the preview cannot run: when the editor's
  rendered blocks do not line up one-to-one with the document's top-level
  blocks at the lift, or when the note changes under the drag (a host
  `setContent`, a sync pull, an undo), which ends the preview and draws the line
  from the next move. → src/features/editor/milkdown/blockDragCurtain.ts
  `measure`, blockDragCurtainWindow.ts `ensureValid`, src/features/editor/milkdown/blockDragSession.ts
- The live-reflow preview follows the note's layout when it changes under a
  drag while the note itself does not: an image that loads, a web font that
  swaps in, a resized window or a rotated phone. The blocks are measured again
  and the preview is redrawn in the same frame, with the slot found again under
  the pointer, so the release still lands exactly where the preview shows; a
  block mid-slide carries on from where it is drawn rather than jumping. A
  release checks the layout again itself, so a change in the very moment of
  release is not missed. It does not fall back to the drop line. Verified in
  Chromium (Playwright) 2026-10-08. → src/features/editor/milkdown/blockDragCurtainClones.ts
  `watch`, blockDragCurtainWindow.ts `followScroll` `remeasure`,
  blockDragCurtain.ts `release`, tests/editor-embed-milkdown-drag-landing.spec.ts
- The desktop ⠿ handle's lifted block is a ghost card the page draws, at the
  block's own on-screen size, never an OS drag image: a clone of the block over
  the block itself (padded by the card's breathing room, like the long press's),
  following the pointer by the distance moved since the lift, with the source
  block dimmed in place. It cannot come out oversized on a scaled display, as
  the OS-drawn drag image did on Linux (QA #012: roughly 200% size on a
  fractionally scaled WebKitGTK display, which nothing the page did could fix).
  → src/features/editor/milkdown/blockDragSession.ts,
  tests/editor-embed-milkdown-gutter-handle.spec.ts
- There is ONE drop slot per boundary between top-level blocks, on both drag
  gestures. Below block A and above the block directly under it are the same
  place, so they are one target: one slot opening in the live-reflow preview
  (or, where the preview falls back, one indicator line, drawn IN the gap
  midway between A's bottom edge and B's top edge, on the outer edge at the
  document's first and last boundary), and one haptic tick for reaching it
  however the pointer got there. A block's OWN two boundaries stay distinct,
  because those are different positions. Both gestures resolve that one slot with the same
  code and commit through the same move, so neither the line's position nor the
  set of places a block may land can differ between them — which is why the
  desktop ⠿ handle draws OUR indicator rather than the one
  @milkdown/kit/plugin/cursor ships (it draws a line on every block's top edge
  AND every block's bottom edge, so each gap had two). →
  src/features/editor/milkdown/blockDragGeometry.ts `resolveDropTarget`,
  src/features/editor/milkdown/blockDragSession.ts,
  src/features/editor/milkdown/blockDragGeometry.test.ts,
  tests/editor-embed-milkdown-gutter-handle-slots.spec.ts
- In the live-reflow preview, which slot is open is judged against the blocks
  where the preview DRAWS them, not where they sat at the lift: the slot moves
  past a block once the pointer passes that block's drawn middle (its own
  middle, not its slot's), and a pointer exactly on it keeps the slot where it
  is. Judged against the lift-time layout instead, a long paragraph dragged
  past a block flipped back the moment the pointer re-entered that block's old
  upper half — a whole paragraph-height inside the paragraph's own drawn slot.
  The slot cannot flip back and forth: passing a block moves it to the other
  side of the slot, away from the pointer. → src/features/editor/milkdown/blockDragCurtainLayout.ts
  `reflowGapAt`, tests/editor-embed-milkdown-gutter-handle-slots.spec.ts
- The dragged block's own two boundaries open no slot, draw no line and tick no
  haptic on either gesture, because a drop there is a no-op: the finger holding
  a block over the gap it already sits against would otherwise show the
  indicator running through the lifted card. On the native long-press the
  lifted card is drawn OVER the indicator line, with a translucent background,
  so the line — and the dimmed source block underneath at lift — stay visible
  through the card wherever it overlaps a boundary. → src/features/editor/milkdown/blockMove.ts
  `isNoOpDrop`, src/features/editor/milkdown/blockDragSession.ts,
  src/features/editor/milkdown/blockMove.test.ts, tests/editor-embed-milkdown-drag-drop-preview.spec.ts
- A block drag is haptic three ways on both native shells: one firmer impact
  when the block lifts, a light tick each time the drop slot (or the indicator
  line, where the preview falls back) lands on a DIFFERENT top-level boundary,
  and one light impact when a release commits a reorder. A finger traveling
  inside one gap ticks nothing, a hold ticks nothing, edge auto-scroll ticks
  nothing (an auto-scroll is a hold, and a tick per boundary swept past would be
  a continuous buzz), and a release back at the source is silent (it commits
  nothing). Same gesture, same three moments, same feel on both. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  apps/ios/Sources/Editor/EditorWebView.swift `moveHapticFeedback`,
  apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt
  `performBlockDragHaptic`,
  tests/editor-embed-milkdown-long-press.spec.ts _(native shells)_
- On Android, a finger landing on a block silences the WebView's OWN long-press
  haptic for the length of the press, so the lift is felt once rather than as
  two impacts an eighth of a second apart. Chromium's long-press recognizer
  trips around touch-down + 480ms, 128-141ms after the editor's 340ms lift. A
  long press anywhere the editor does NOT claim as a block press still gets the
  platform's normal buzz, and the editor's own three haptics are exempted rather
  than silenced with it. Measured on a device 2026-09-01. →
  apps/android/app/src/main/java/com/futo/notes/ui/EditorWebView.kt
  `setBlockPressActive`, packages/editor/src/bridge.ts `BlockPressMessage`
  _(native shells, Android)_
- On Android that is ALL the shell does for the drag: Chromium's visible text
  interaction never appears over a lifted block. A stationary hold, editable
  focused and unfocused, draws no word highlight, no selection handles, no
  floating Cut/Copy action mode and no magnifier — the page's own suppression
  holds, which is the difference from WebKit. So the shell ignores `blockDrag`
  entirely FOR THOSE SELECTION VISUALS. Measured on a device 2026-09-01. Focus
  is a separate story — see the next two lines. →
  src/features/editor/milkdown/mobileBlockDnd.ts,
  packages/editor/src/bridge.ts `BlockDragMessage`
  _(native shells, Android)_
- An empty paragraph cannot be lifted: a hold on it lifts nothing and buzzes
  nothing, though the press still stands the platform's own hold gestures
  down like any block press. A tester's report — holding an empty line lifted
  a blank "phantom" card while, by the next line's mechanism, the keyboard
  rose underneath it — made the two visibly collide. →
  src/features/editor/milkdown/mobileBlockDnd.ts, tests/editor-embed-milkdown-long-press-slots.spec.ts
  _(native shells)_
- A block press that begins with the editor unfocused never focuses it or
  raises the keyboard, however long it lasts and whether or not it lifts; a
  press that begins focused leaves focus alone (a drag while typing must not
  drop the keyboard). Measured on the pool emulator 2026-09-08 (Android 16,
  System WebView 133), touch stationary with the editor unfocused: Chromium's
  OWN long-press fires at touch-down + ~500ms and dispatches, in the same
  millisecond, `selectstart` on the block, `focus` on the editable, `focusin`,
  then `contextmenu` — and the `focus` lands regardless of the page canceling
  `selectstart`/`contextmenu`/`touchend`; none of those three levers stop it,
  on text blocks as well as empty ones. A capture-phase `focus` listener on
  the document undoes it for a press that began unfocused. →
  src/features/editor/milkdown/mobileBlockDnd.ts, packages/editor/src/bridge.ts
  `FocusMessage`, tests/editor-embed-milkdown-drag-press-focus.spec.ts _(native shells, Android)_
