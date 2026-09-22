/*
 * Pure placement math for the row/column grips (`tableGrips.ts`), split out
 * so it is testable without a real layout engine: jsdom's `getBoundingClientRect`
 * always answers with zeros (it does not run layout at all), so a test that
 * wants to check "given this cell's rect, where does the grip go" has to
 * supply the rect itself rather than asking a mounted DOM for one. The real
 * plugin is the only caller that measures actual elements; everything here
 * takes plain rect data.
 */

/** A subset of `DOMRect` — just the fields this module needs. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the column grip sits: centered horizontally over the header cell,
 * `gap` px above it. `position: fixed` in viewport coordinates, so no scroll
 * compensation — same contract as `blockDropIndicator.ts`'s indicator.
 */
export function columnGripRect(headerCellRect: Rect, gripSize: number, gap: number): Rect {
  return {
    left: headerCellRect.left + headerCellRect.width / 2 - gripSize / 2,
    top: headerCellRect.top - gap - gripSize,
    width: gripSize,
    height: gripSize,
  };
}

/**
 * Where the row grip sits: centered vertically against the row, `gap` px to
 * the left of it.
 */
export function rowGripRect(rowRect: Rect, gripSize: number, gap: number): Rect {
  return {
    left: rowRect.left - gap - gripSize,
    top: rowRect.top + rowRect.height / 2 - gripSize / 2,
    width: gripSize,
    height: gripSize,
  };
}

/** Whether `x,y` falls inside `rect` — used both for "is the pointer still
 * over the table" and for the grips' own (generous) hit-testing. */
export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return (
    x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
  );
}

/**
 * A rect expanded by `margin` on every side — the column/row hit zone is
 * wider than the visible grip so the pointer does not have to land on a
 * ~20px target exactly to keep it showing while travelling toward it.
 */
export function expandRect(rect: Rect, margin: number): Rect {
  return {
    left: rect.left - margin,
    top: rect.top - margin,
    width: rect.width + margin * 2,
    height: rect.height + margin * 2,
  };
}

/**
 * `rect` nudged fully inside `[0, viewportWidth] x [0, viewportHeight]`.
 *
 * `columnGripRect` places its grip ABOVE the header cell and `rowGripRect`
 * places its LEFT of the row — both go negative (off-screen, unclickable)
 * for a table with no room on that side, which is the ordinary case for a
 * table that is the first block in a note (nothing above it to scroll past).
 * Clamping never changes the rect's size, only where it sits, so a clamped
 * grip may overlap the table itself rather than floating clear of it — still
 * visible and clickable beats vanishing.
 */
export function clampRectToViewport(
  rect: Rect,
  viewportWidth: number,
  viewportHeight: number,
): Rect {
  const maxLeft = Math.max(0, viewportWidth - rect.width);
  const maxTop = Math.max(0, viewportHeight - rect.height);
  return {
    left: Math.min(Math.max(rect.left, 0), maxLeft),
    top: Math.min(Math.max(rect.top, 0), maxTop),
    width: rect.width,
    height: rect.height,
  };
}
