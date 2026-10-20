/** The extent `holdScrollExtent` is holding on an editor, by editor. */
const extentHolds = new WeakMap<HTMLElement, { extra: number; release: () => void }>();

/** Gives `el` (the scroller) `extra` px more scroll extent than the note will
 * have after a drop that shortens it, so its scroll position stays reachable.
 * It is a transparent bottom border on `editor`, apart from the stylesheet's
 * bottom padding (`max(40vh, 280px)`), which goes on following the viewport
 * underneath: removing the border takes away exactly `extra`, whatever the
 * viewport did meanwhile. (On the embed the editor is the scroller, and the
 * border shortens its visible box; on desktop it lengthens the content. The
 * extent grows by `extra` either way.) It is released at the first scroll, or
 * change of the editor's blocks (another note opened), that leaves the view
 * clear of it, so releasing it never moves the view. A second drop before
 * then adds to the first. */
export function holdScrollExtent(
  editor: HTMLElement,
  el: HTMLElement,
  scroller: HTMLElement | Window,
  extra: number,
): void {
  const held = extentHolds.get(editor);
  if (held) {
    held.extra += extra;
    editor.style.borderBottom = `${held.extra}px solid transparent`;
    return;
  }
  const blocks = new MutationObserver(() => hold.release());
  const hold = {
    extra,
    release: () => {
      // Without the extent, the furthest the view can scroll; past it, the
      // browser would clamp the scroll position and move the view.
      if (el.scrollTop > Math.max(0, el.scrollHeight - hold.extra - el.clientHeight) + 0.5) {
        return;
      }
      scroller.removeEventListener('scroll', hold.release);
      blocks.disconnect();
      editor.style.removeProperty('border-bottom');
      extentHolds.delete(editor);
    },
  };
  extentHolds.set(editor, hold);
  editor.style.borderBottom = `${extra}px solid transparent`;
  scroller.addEventListener('scroll', hold.release, { passive: true });
  blocks.observe(editor, { childList: true });
}

/** `el`'s padding box in client coordinates: what of its content is visible,
 * without its scrollbars. */
export function visibleBox(el: HTMLElement): {
  top: number;
  left: number;
  width: number;
  height: number;
} {
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top + el.clientTop,
    left: rect.left + el.clientLeft,
    width: el.clientWidth,
    height: el.clientHeight,
  };
}

/** How far the margin of `el`'s first (`top`) or last (`bottom`) descendants
 * reaches out through that edge. In the document that margin collapses OUTSIDE
 * the block (a list's first item, say), so the block's top is its content's
 * top, and the margin joins the block's own in the gap to its neighbour. A
 * clone is absolutely positioned — a formatting context of its own — which
 * keeps the margin inside and would draw the content that much lower (2.5px
 * for a list on the reference phone) unless the clone is raised by it. */
export function collapsedMargin(el: HTMLElement, edge: 'top' | 'bottom'): number {
  const win = el.ownerDocument.defaultView ?? window;
  const side = edge === 'top' ? 'Top' : 'Bottom';
  let through = 0;
  for (let n: Element = el; ;) {
    const style = win.getComputedStyle(n);
    if (n !== el) through = collapse(through, parseFloat(style[`margin${side}`]) || 0);
    const contained =
      (style.display !== 'block' && style.display !== 'list-item') ||
      style.overflowY !== 'visible' ||
      parseFloat(style[`padding${side}`]) > 0 ||
      parseFloat(style[`border${side}Width`]) > 0;
    let next = edge === 'top' ? n.firstChild : n.lastChild;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent?.trim()) {
      next = edge === 'top' ? next.nextSibling : next.previousSibling;
    }
    if (contained || !(next instanceof Element)) return through;
    n = next;
  }
}

/** Two adjoining vertical margins as the browser collapses them into one: the
 * largest positive plus the most negative. */
export function collapse(a: number, b: number): number {
  return Math.max(a, b, 0) + Math.min(a, b, 0);
}

/** What the editor's text is drawn on, so the curtain hides the real blocks
 * without a seam: the first opaque-ish background at or above `el`, else the
 * embed's `--futo-editor-surface` (the native hosts paint their own colour
 * behind a transparent page; editor.html), else the colour scheme's paper. */
export function backgroundBehind(el: HTMLElement): string {
  const win = el.ownerDocument.defaultView ?? window;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const color = win.getComputedStyle(n).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  const root = el.ownerDocument.documentElement;
  const surface = win.getComputedStyle(root).getPropertyValue('--futo-editor-surface').trim();
  if (surface) return surface;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : win.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return dark ? '#1a1a1a' : '#fcfcfc';
}
