import { puppetRefusal, puppetVerb, type PuppetVerb } from './puppetRegistry';

/**
 * The instant scroll: whatever scrolls under a point moves by a distance at once, as the
 * page's own `scrollBy` does, instead of the run of real wheel events the `scroll` gesture
 * sends (about 0.5 s plus 0.1 s a notch, measured). It is not input a person produces, so
 * `actions` lists it with `convenience: true`: the tool for getting somewhere, never for
 * checking what scrolling itself does (wheel handlers, momentum, scroll-linked UI).
 */

type Axis = 'x' | 'y';

/** Whether `element` scrolls along `axis`: it allows it, and has more than a rounding pixel to move. */
export function scrollsAlong(element: Element, axis: Axis): boolean {
  const overflow = getComputedStyle(element)[axis === 'y' ? 'overflowY' : 'overflowX'];
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return axis === 'y'
    ? element.scrollHeight > element.clientHeight + 1
    : element.scrollWidth > element.clientWidth + 1;
}

/** What scrolls `element` along `axis`: its nearest ancestor that can, else the page. */
function scrollerOf(element: Element | null, axis: Axis): Element | null {
  for (let node = element; node; node = node.parentElement) {
    if (scrollsAlong(node, axis)) return node;
  }
  return document.scrollingElement;
}

/** The element a wheel at this point would scroll. */
function scrollerAt(x: number, y: number, axis: Axis): Element | null {
  return scrollerOf(document.elementFromPoint(x, y), axis);
}

/**
 * Scrolls `scroller` to a place, never by a distance: WebKit on iOS applies a relative
 * scroll to its own copy of the offset, and a copy the page's last move had not reached yet
 * (a caret reveal) put a second ScrollToLine twice as far down. Instant, as no CSS here
 * asks for smooth scrolling.
 */
export function scrollTo(scroller: Element, left: number, top: number): void {
  scroller.scrollLeft = left;
  scroller.scrollTop = top;
}

/** Resolves after the page's next frame, or past the same ceiling in a window that draws none. */
export function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const ceiling = setTimeout(resolve, SCROLL_LANDED_CEILING_MS);
    requestAnimationFrame(() => {
      clearTimeout(ceiling);
      resolve();
    });
  });
}

/** Past this, answer anyway: the event is late, not lost (measured tail: 0.6 s, hidden window). */
const SCROLL_LANDED_CEILING_MS = 2000;

/**
 * Resolves once the browser fires its own `scroll` for a script's scroll just made. WebKit
 * scrolls wheel input on its scrolling thread, from a copy of the offset it learns of only in
 * the page's next rendering update, the one that fires `scroll`. A hidden window (the usual
 * agent run) can put that update off until input arrives, and a real wheel sent before it
 * lost a notch (measured: 3,000 px asked, 2,880 moved, one run in five). Its handlers have
 * also run by then, so a virtualized list has mounted the rows that came into view.
 */
export function scrollLanded(scroller: Element): Promise<undefined> {
  const target = scroller === document.scrollingElement ? document : scroller;
  return new Promise((resolve) => {
    const landed = () => {
      clearTimeout(ceiling);
      target.removeEventListener('scroll', landed);
      resolve(undefined);
    };
    const ceiling = setTimeout(landed, SCROLL_LANDED_CEILING_MS);
    target.addEventListener('scroll', landed);
  });
}

export function scrollByVerb(): PuppetVerb {
  return puppetVerb(
    'ScrollBy',
    { x: 'integer', y: 'integer', dy: 'integer?', dx: 'integer?' },
    (args) => {
      const dx = (args.dx as number | undefined) ?? 0;
      const dy = (args.dy as number | undefined) ?? 0;
      if (dx === 0 && dy === 0) {
        return puppetRefusal(400, 'ScrollBy needs a non-zero "dy" (down is positive) or "dx"');
      }
      const scroller = scrollerAt(args.x as number, args.y as number, dy !== 0 ? 'y' : 'x');
      if (!scroller) return puppetRefusal(409, 'nothing scrolls at that point');
      const before = [scroller.scrollLeft, scroller.scrollTop];
      scrollTo(scroller, before[0] + dx, before[1] + dy);
      if (scroller.scrollLeft === before[0] && scroller.scrollTop === before[1]) {
        return puppetRefusal(409, 'what scrolls at that point is already at its end that way');
      }
      return scrollLanded(scroller);
    },
    { convenience: true },
  );
}
