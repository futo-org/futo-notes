/* The pane the note scrolls in, as the caret's follow (caret.ts) and the pointer's and the keys'
 * hit-test (hitTest.ts) scroll it. */

/** The pane `element` scrolls in. */
export function scrollerOf(element: HTMLElement): HTMLElement {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(at).overflowY)) return at;
  }
  return document.documentElement;
}

/** Scroll the pane, by no more than it takes, so viewport `y` is at least `height` inside its
 *  top and bottom, the bottom raised by `bottomInset` (a bar over it); returns `y` where that
 *  point is after the scroll. */
export function reveal(y: number, height: number, scroller: HTMLElement, bottomInset = 0): number {
  const pane = scroller.getBoundingClientRect();
  const bottom = pane.bottom - bottomInset;
  const distance = Math.min(0, y - height - pane.top) || Math.max(0, y + height - bottom);
  if (!distance) return y;
  const before = scroller.scrollTop;
  scroller.scrollTop += distance;
  return y - (scroller.scrollTop - before);
}
