import { describe, expect, it } from 'vitest';

import {
  clampRectToViewport,
  columnGripRect,
  expandRect,
  pointInRect,
  rowGripRect,
} from './tableGripsGeometry';

describe('columnGripRect', () => {
  it('centers horizontally over the cell and sits gap px above it', () => {
    const rect = columnGripRect({ left: 100, top: 50, width: 40, height: 20 }, 16, 4);
    expect(rect.left).toBe(100 + 20 - 8); // centered: cell center minus half grip
    expect(rect.top).toBe(50 - 4 - 16); // above, with the gap
    expect(rect.width).toBe(16);
    expect(rect.height).toBe(16);
  });
});

describe('rowGripRect', () => {
  it('centers vertically against the row and sits gap px to its left', () => {
    const rect = rowGripRect({ left: 100, top: 50, width: 200, height: 30 }, 16, 4);
    expect(rect.left).toBe(100 - 4 - 16);
    expect(rect.top).toBe(50 + 15 - 8);
  });
});

describe('pointInRect', () => {
  it('is true on and inside the boundary, false outside', () => {
    const rect = { left: 0, top: 0, width: 10, height: 10 };
    expect(pointInRect(0, 0, rect)).toBe(true);
    expect(pointInRect(10, 10, rect)).toBe(true);
    expect(pointInRect(5, 5, rect)).toBe(true);
    expect(pointInRect(-1, 5, rect)).toBe(false);
    expect(pointInRect(5, 11, rect)).toBe(false);
  });
});

describe('expandRect', () => {
  it('grows every side by margin, keeping the same center', () => {
    const rect = expandRect({ left: 10, top: 10, width: 10, height: 10 }, 5);
    expect(rect).toEqual({ left: 5, top: 5, width: 20, height: 20 });
  });
});

describe('clampRectToViewport', () => {
  it('leaves a rect that already fits untouched', () => {
    const rect = { left: 50, top: 50, width: 18, height: 18 };
    expect(clampRectToViewport(rect, 800, 600)).toEqual(rect);
  });

  it('pulls a column grip that would sit above the viewport back down to 0 — the table-at-the-top case', () => {
    // A header cell near y=20 places its grip 22px above it: negative, and
    // Playwright (this repo's real-browser test) treats a negative-top fixed
    // element as not visible — this is the bug that finding caught.
    const rect = { left: 52, top: -7.5, width: 18, height: 18 };
    const clamped = clampRectToViewport(rect, 1280, 800);
    expect(clamped.top).toBe(0);
    expect(clamped.left).toBe(52); // only the offending axis moves
  });

  it('pulls a row grip that would sit left of the viewport back to 0 — the table flush to the left edge', () => {
    const rect = { left: -8, top: 100, width: 18, height: 18 };
    expect(clampRectToViewport(rect, 1280, 800).left).toBe(0);
  });

  it('never lets the rect run past the right/bottom edge either', () => {
    const rect = { left: 1270, top: 790, width: 18, height: 18 };
    const clamped = clampRectToViewport(rect, 1280, 800);
    expect(clamped.left).toBe(1262); // 1280 - 18
    expect(clamped.top).toBe(782); // 800 - 18
  });

  it('never changes the rect size', () => {
    const rect = { left: -100, top: -100, width: 18, height: 18 };
    const clamped = clampRectToViewport(rect, 50, 50);
    expect(clamped.width).toBe(18);
    expect(clamped.height).toBe(18);
  });
});
