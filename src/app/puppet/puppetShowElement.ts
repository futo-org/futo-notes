/**
 * The `show` query: one element in depth — its row, box model, stacking, the
 * ancestors that clip it, and where it paints but does not receive a pointer.
 */

import { describeElement, handlersOf, rectOf, refOf, type Rect } from './puppetElements';

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Ancestors that clip this element: overflow not visible and a rect that does not contain it. */
function clippingChain(element: Element, rect: Rect): string[] {
  const chain: string[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflow === 'visible' && style.clipPath === 'none') continue;
    const outer = rectOf(node);
    const inside =
      rect.x >= outer.x &&
      rect.y >= outer.y &&
      rect.x + rect.w <= outer.x + outer.w &&
      rect.y + rect.h <= outer.y + outer.h;
    if (!inside) chain.push(`${refOf(node)} overflow:${style.overflow}`);
  }
  return chain;
}

interface ProbeMiss {
  point: string;
  x: number;
  y: number;
  by: string | null;
}

/**
 * Hit versus paint. Analytic first: the element paints its whole rect minus
 * what the corner radii cut off. Then the browser adjudicates at exactly the
 * predicted boundary — just inside each edge midpoint and each rounded corner.
 * A point the element paints but does not receive is a miss, and the element
 * that took it instead is named.
 */
function hitVersusPaint(element: Element): { matches: boolean; misses: ProbeMiss[] } {
  const rect = rectOf(element);
  const style = getComputedStyle(element);
  const inset = (radius: string) => Math.max(1, Math.ceil(pixels(radius) * (1 - Math.SQRT1_2)) + 1);
  const points: Array<[string, number, number]> = [
    ['top', rect.x + rect.w / 2, rect.y + 1],
    ['right', rect.x + rect.w - 1, rect.y + rect.h / 2],
    ['bottom', rect.x + rect.w / 2, rect.y + rect.h - 1],
    ['left', rect.x + 1, rect.y + rect.h / 2],
    [
      'top-left',
      rect.x + inset(style.borderTopLeftRadius),
      rect.y + inset(style.borderTopLeftRadius),
    ],
    [
      'top-right',
      rect.x + rect.w - inset(style.borderTopRightRadius),
      rect.y + inset(style.borderTopRightRadius),
    ],
    [
      'bottom-right',
      rect.x + rect.w - inset(style.borderBottomRightRadius),
      rect.y + rect.h - inset(style.borderBottomRightRadius),
    ],
    [
      'bottom-left',
      rect.x + inset(style.borderBottomLeftRadius),
      rect.y + rect.h - inset(style.borderBottomLeftRadius),
    ],
  ];
  const misses: ProbeMiss[] = [];
  for (const [point, x, y] of points) {
    if (!document.elementFromPoint) break;
    const winner = document.elementFromPoint(x, y);
    if (winner && (winner === element || element.contains(winner))) continue;
    misses.push({ point, x: Math.round(x), y: Math.round(y), by: winner ? refOf(winner) : null });
  }
  return { matches: misses.length === 0, misses };
}

/** Everything about one element: the row, box model, stacking, clipping, hit-vs-paint. */
export function showElement(element: Element): Record<string, unknown> {
  const row = describeElement(element);
  const style = getComputedStyle(element);
  return {
    ...row,
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: [...element.classList],
    cursor: style.cursor,
    box: {
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
        pixels,
      ),
      border: [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].map(pixels),
      margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].map(
        pixels,
      ),
      radius: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map(pixels),
    },
    allHandlers: handlersOf(element, { all: true }),
    position: style.position,
    zIndex: style.zIndex,
    pointerEvents: style.pointerEvents,
    overflow: style.overflow,
    clippedBy: clippingChain(element, row.rect),
    hitVersusPaint: hitVersusPaint(element),
    children: element.childElementCount,
  };
}
