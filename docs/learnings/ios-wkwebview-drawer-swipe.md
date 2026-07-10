# iOS WKWebView drawer swipe vs. native momentum scroll

Investigation log from the abandoned `swipe-fixes` branch. The whole
branch was discarded — none of the code here is in `main`. Save this so
the next person to swing at the same bug doesn't repeat the dead ends.

## The bug

The mobile drawer (`DrawerSidebar`) is a scrollable panel. With the
drawer open, the user wants to swipe right-to-left from anywhere in the
sidebar to close it. On iPhone hardware (not the simulator):

- Fresh touch from inside the sidebar → close-swipe works
- Touch landed during in-flight momentum scroll, or just-finished scroll
  → swipe doesn't register. It either:
  - Gets swallowed by the scroll gesture (treated as part of the scroll
    decel), or
  - Halts the scroll and goes nowhere — the drawer doesn't move.

Starting the close-swipe from outside the sidebar (the dimmed
note-viewer overlay) always works because there's no scroll-recognizer
competition there.

## Core insight

**Once iOS WKWebView's `UIScrollView` pan gesture recognizer has
engaged on a touch, JS cannot claw the gesture back.** Not via
`touch-action`, not via `preventDefault` on touchmove, not via any
other web API. The recognizer is below the WebKit web-content layer
and owns the touch end-to-end.

This is fundamentally different from:
- Android WebView (touchmove `preventDefault` during momentum works)
- Desktop browsers (no momentum gesture recognizer in the way)
- Even iOS Safari proper for the simpler cases

The corollary: to win the gesture, JS must **prevent the recognizer
from engaging in the first place**. There is no "release the touch
from the scroller mid-gesture" path.

## Approaches tried (in order)

### 1. Lenient vertical-vs-horizontal classification

Changed `isVertical = |Δx| < |Δy|` to `|Δy| > 2·|Δx|` when the drawer
is open or the touch started at the left edge. Helps diagonal
close-swipes register on fresh touches. Does **not** address the
momentum-stealing scenario at all.

### 2. `touch-action: pan-y` on the scroll container

The spec says this constrains native gesture handling on the element
to vertical pan only, handing horizontal motion to JS. In practice
this only governs whether a *new* gesture engages the scroller; an
*in-flight* momentum gesture's recognizer has already claimed the
touch by the time our new touch lands. `touch-action` does nothing
for that case.

### 3. State machine with explicit yield/drag commit

Added a `yielded` flag and a 5–6 px commit threshold:

- During the first frames, neither claim nor yield — wait for clear
  signal.
- Once we yield to vertical, lock that decision (don't try to re-claim
  if the gesture later goes horizontal).
- Once we commit to drag, lock that too.

Cleaner state machine. Improves the "what does the classifier do mid
gesture?" question. Doesn't fix momentum stealing because the scroller
has the touch before our classifier ever runs.

### 4. Seize the scroller — `overflow-y: hidden` + manual JS scroll

The only thing that actually fixed the bug:

```js
function handleTouchStart(event) {
  // ... existing
  if (config.getDrawerOpen()) {
    const scrollEl = findSidebarScroll(event.target);
    if (scrollEl) {
      capturedScrollEl = scrollEl;
      capturedStartScrollTop = scrollEl.scrollTop;
      scrollEl.style.overflowY = 'hidden';
      // Force the style to apply synchronously so the native scroll
      // recognizer sees a non-scrollable container before it decides
      // whether to engage on this touch.
      void scrollEl.offsetHeight;
    }
  }
}
```

By making the container non-scrollable at touchstart (and forcing a
synchronous reflow with `void el.offsetHeight`), the scroll recognizer
has nothing to engage on. Subsequent touchmove events fire reliably to
JS. We disambiguate horizontal vs vertical and act accordingly:

- **Horizontal** → drive the drawer transform (as before).
- **Vertical** → manually scroll the container by setting `scrollTop`.
- **Touchend after vertical** → apply momentum decel in JS (exponential
  decay scaled by `dt/16` so it's frame-rate-independent), then restore
  `overflow-y: ''` when momentum settles or hits a boundary.

This **works**. But the cost is:

- Vertical scroll inside the sidebar is now JS-driven, not native.
- iOS's rubber-band bounce, exact decel curve, and natural fling feel
  are gone — replaced by a JS approximation.
- The approximation is close-ish but not pixel-identical, and the
  difference is felt.

The user's verdict: **the original "minor annoyance" of occasionally
missing a close-swipe is preferable to JS-driven vertical scroll.**
Accept the bug. Don't seize the scroller.

## Workable approaches NOT taken

If the bug ever becomes pressing enough to fix:

- **Edge-only close gesture**: only treat close-swipes that started
  from the right-most ~30 px of the open drawer (or from the dimmed
  overlay) as drawer drags. Loses ergonomics but sidesteps the
  scroll-recognizer competition entirely.
- **Fully JS-driven virtual scroller** for the sidebar list. Massive
  rewrite. Would also enable other gesture refinements but vastly
  overscoped for the symptom.

## Smaller related findings from the same session

These were also explored on the discarded branch and are equally not
in `main`:

- **Drawer-swipe threshold tuning**: edge zone 30→35 px, min-drag
  3/5→2.55/4.25 px, velocity 0.3/0.5→0.255/0.425, completion progress
  0.3→0.255. A clean 15 % reduction across the board.
- **Removed the right-edge swipe**: it triggered the
  `graphPanel.openGraph()` toast ("Graph visualization coming soon").
  This path lived in the legacy shared-app mobile swipe subsystem, which was
  later deleted when that unreachable mobile layout was removed.

## Validation lesson

iOS simulator passes are not real-iPhone passes for momentum/gesture
work. The simulator's WKWebView scroll-recognizer behavior is close
but not identical to real device. **Validate on physical hardware** —
the difference here was the entire bug.

## Files involved at the time of the investigation

- `src/lib/touchSwipe.svelte.ts` — gesture handler factory (later deleted with
  the unreachable shared-app mobile layout)
- `src/components/NotesShell.svelte` — wires the handler to the root
  shell element's touch events
- `src/components/FolderTreeView.svelte` — owns `.folder-tree-scroll`,
  the scroller in question
- `src/components/DrawerSidebar.svelte` — the drawer container itself
  (does not scroll)
