/**
 * Where an element is on the page, in the words the phones use for theirs
 * (crates/futo-puppet/src/native.rs): the region (`sidebar`, `top bar`, `main`,
 * a `list`, else `content`), prefixed by the surface it sits on
 * (`dialog`, `menu`, followed by the row a row's menu is open for) — so `elements` reads as
 * one outline on every platform.
 * Also: whether a pointer at the element would reach it, and how far each
 * scrolling part of the page can still scroll.
 */

import { scrollsAlong } from './puppetScroll';

/**
 * A container names its region with `data-puppet-section`, and a landmark names
 * its own (`aside` the sidebar, `main` the main area). Nested regions read
 * outermost first: the sidebar's tree is `sidebar · list`.
 */
function regionOf(element: Element): string | null {
  const names: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const name =
      node.getAttribute('data-puppet-section') ??
      (node.tagName === 'ASIDE' ? 'sidebar' : node.tagName === 'MAIN' ? 'main' : null);
    if (name && names[0] !== name) names.unshift(name);
  }
  return names.length > 0 ? names.join(' · ') : null;
}

function surfaceOf(element: Element): string | null {
  if (element.closest('[role="menu"]')) return 'menu';
  if (element.closest('[role="dialog"], [aria-modal="true"], [data-puppet-surface="dialog"]')) {
    return 'dialog';
  }
  return null;
}

export function sectionOf(element: Element): string {
  const surface = surfaceOf(element);
  if (surface === 'menu') {
    const openFor = element.closest('[role="menu"]')?.getAttribute('data-puppet-section');
    return openFor ? `menu · ${openFor}` : surface;
  }
  const region = regionOf(element);
  if (surface && region) return `${surface} · ${region}`;
  return surface ?? region ?? 'content';
}

function reaches(element: Element, x: number, y: number): boolean {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return false;
  if (hit === element || element.contains(hit)) return true;
  // Something holding it took the pointer for it (a cell around its row), unless a box between
  // them clips it away there: then the hit is a dialog's backdrop under a row scrolled out of view.
  return hit.contains(element) && !clippedAt(element, hit, x, y);
}

function clippedAt(element: Element, holder: Element, x: number, y: number): boolean {
  for (let node = element.parentElement; node && node !== holder; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const box = node.getBoundingClientRect();
    if (x < box.left || x >= box.left + box.width || y < box.top || y >= box.top + box.height) {
      return true;
    }
  }
  return false;
}

/**
 * Where a pointer reaches the element: its centre when that lands on it (on it,
 * inside it, or on something holding it that takes the pointer for it), else
 * the first point of a 3×3 grid over it that does — a button half under
 * another is still clickable on its free half, and its centre would click the
 * other one. Null when no point reaches it: a dialog, an overlay or a scroll
 * container's clipped edge is in the way. Without a hit test (jsdom) there is
 * no telling, so the centre.
 */
export function aimPoint(element: Element): { x: number; y: number } | null {
  const box = element.getBoundingClientRect();
  const at = (fx: number, fy: number) => ({
    x: Math.round(box.left + box.width * fx),
    y: Math.round(box.top + box.height * fy),
  });
  if (typeof document.elementFromPoint !== 'function') return at(0.5, 0.5);
  for (const fy of [0.5, 0.2, 0.8]) {
    for (const fx of [0.5, 0.2, 0.8]) {
      const point = at(fx, fy);
      if (reaches(element, point.x, point.y)) return point;
    }
  }
  return null;
}

const scrolls = (element: Element): boolean =>
  scrollsAlong(element, 'y') || scrollsAlong(element, 'x');

/** The scrolling container a row sits in; the editor scrolls its own document inside it. */
function scrollerOf(element: Element): Element | null {
  const own = element.classList.contains('ProseMirror') ? element : null;
  if (own && scrolls(own)) return own;
  for (
    let node = element.parentElement;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (scrolls(node)) return node;
  }
  return null;
}

export interface ScrollEntry {
  section: string;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  /** 1-based position of the first and last listed row, and the rows the list holds. */
  first?: number;
  last?: number;
  total?: number;
}

/**
 * A virtualized list renders only the rows near the viewport, so it says how
 * many it holds (`data-puppet-rows`) and which one it renders first
 * (`data-puppet-first-row`): a listed row's position is that plus its place
 * among the rendered rows.
 */
function rowPosition(scroller: Element, element: Element): number | null {
  const first = Number(scroller.getAttribute('data-puppet-first-row'));
  if (!Number.isInteger(first)) return null;
  const rendered = [...scroller.children].filter((child) => !child.hasAttribute('aria-hidden'));
  const index = rendered.findIndex((child) => child === element || child.contains(element));
  return index < 0 ? null : first + index + 1;
}

/** How far each scrolling container holding one of these rows can still move. */
export function scrollEntries(elements: Element[]): ScrollEntry[] {
  const entries = new Map<Element, ScrollEntry>();
  for (const element of elements) {
    const scroller = scrollerOf(element);
    if (!scroller) continue;
    let entry = entries.get(scroller);
    if (!entry) {
      entry = {
        section: sectionOf(element),
        up: scroller.scrollTop > 0,
        down: scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1,
        left: scroller.scrollLeft > 0,
        right: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
      };
      const total = Number(scroller.getAttribute('data-puppet-rows'));
      if (Number.isInteger(total) && scroller.hasAttribute('data-puppet-rows')) entry.total = total;
      entries.set(scroller, entry);
    }
    const position = rowPosition(scroller, element);
    if (position !== null) {
      entry.first = Math.min(entry.first ?? position, position);
      entry.last = Math.max(entry.last ?? position, position);
    }
  }
  return [...entries.values()];
}
