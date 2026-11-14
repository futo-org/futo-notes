#### Block drag: lifting and drop slots

This section describes the web editor and its standalone touch fixtures. Native mobile
uses Linedown; rendered block movement is deferred in [remaining work](../../portable-core/remaining-work.md).

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