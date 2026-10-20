import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { tablePosOf, type CellLocation } from './tableCommands';
import { expandRect, pointInRect, type Rect } from './tableGripsGeometry';

export const GRIP_CLASS = 'futo-table-grip';
export const GRIP_COL_CLASS = 'futo-table-grip-col';
export const GRIP_ROW_CLASS = 'futo-table-grip-row';
export const MENU_CLASS = 'futo-table-grip-menu';
export const MENU_ITEM_CLASS = 'futo-table-grip-menu-item';

/** CSS px. Small on purpose (desktop, mouse-first) — the brief for this lane
 * notes touch targets this size are a known rough edge for fingers rather
 * than something to redesign here. */
export const GRIP_SIZE = 18;
export const GRIP_GAP = 4;
/** How far past a grip's own box the pointer may wander and still count as
 * "hovering it", so the grip does not vanish the instant the pointer nears
 * its edge on the way to clicking it. */
export const GRIP_HOVER_MARGIN = 10;

export function domRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** The actual rendered `<table>` for `loc`, or null if the view has nothing
 * at that position (the table was just removed). */
export function tableElementFor(view: ProseView, loc: CellLocation): HTMLTableElement | null {
  const dom = view.nodeDOM(tablePosOf(loc));
  return dom instanceof HTMLTableElement ? dom : null;
}

export function applyRect(el: HTMLElement, rect: Rect): void {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
}

/** Re-exported for tests that want to check hit-testing without a live view. */
export function isNearGrip(x: number, y: number, gripRect: Rect): boolean {
  return pointInRect(x, y, expandRect(gripRect, GRIP_HOVER_MARGIN));
}
