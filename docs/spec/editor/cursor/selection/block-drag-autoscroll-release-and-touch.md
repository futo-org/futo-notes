#### Block drag: autoscroll, release and touch suspension

This section describes the web editor and its standalone touch fixtures. Native mobile
uses Linedown; rendered block movement is deferred in [remaining work](../../portable-core/remaining-work.md).

- A block drag holding the pointer within 64px of the visible top or bottom edge
  of whatever scrolls the note — the editable itself in the standalone embed,
  `.note-body` (title and editor together) on desktop — scrolls it continuously — 200px/s at the zone's inner lip
  ramping to 1400px/s at the edge — so a block can be dropped at a boundary that
  was off screen when it was lifted. It runs while the pointer holds still, stops
  at the document's ends, and stops on every exit (commit, no-op release, cancel,
  editor destroy). The drop slot is recomputed each frame from the boundary
  now under the stationary pointer. Both drag paths share it: the standalone touch fixture's
  long-press drag and the desktop ⠿ gutter handle's mouse drag. Verified on an
  Android device 2026-09-01 — a hold within the zone scrolls continuously and
  stops on release; a hold mid-viewport does not scroll. Desktop measured the
  editable's own box until #270, so a hold at the window edge never scrolled. →
  src/features/editor/milkdown/blockDragGeometry.ts `createDragAutoScroller`,
  src/features/editor/milkdown/blockDragSession.ts,
  src/features/editor/milkdown/blockDragGeometry.autoScroll.test.ts,
  tests/editor-embed-milkdown-drag-autoscroll.spec.ts, tests/editor-scroll.spec.ts
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
  src/features/editor/milkdown/blockDragCurtain.ts `holdScrollThroughDrop`,
  blockDragCurtainDom.ts `holdScrollExtent`, src/features/editor/milkdown/blockDragSession.ts,
  tests/editor-embed-milkdown-drag-slides.spec.ts
- Only the dropped block moves at the release, snapping into its slot: a
  neighbor still sliding out of the way when the finger lifts finishes its
  slide, and the move is committed (and the note reported changed) once the
  slides end, at most ~0.18s later. A scroll or a layout change in that time (a
  resized window, an image loading) commits it at once, which is a relayout of
  the screen anyway; an edit elsewhere commits it at once, mapped through the
  edit; a change that takes the block away (another note opened) cancels it,
  and the new note shows at once; the editor going away cancels it. No new drag
  lifts until it has committed. Verified in Chromium (Playwright) 2026-10-09. →
  src/features/editor/milkdown/blockDragSession.ts `land`,
  src/features/editor/milkdown/blockDragCurtain.ts `land`,
  tests/editor-embed-milkdown-drag-landing.spec.ts