// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';

import { positionBelowText, resolveTapPositionAt } from './pointerHitTest';

function fakeView(overrides: {
  posAtCoords?: (coords: { x: number; y: number }) => number | null;
  posAtDOM?: () => number;
  line?: { from: number; to: number };
  /** Row tops the position draws at, per association. */
  rowTops?: { before: number; after: number };
  coordsAtPos?: (position: number, side?: number) => DOMRect | null;
}) {
  const line = overrides.line ?? { from: 23, to: 31 };
  const rows = overrides.rowTops;
  return {
    dom: document.body,
    posAtCoords: vi.fn(overrides.posAtCoords ?? (() => 26)),
    posAtDOM: vi.fn(overrides.posAtDOM ?? (() => line.from)),
    coordsAtPos: vi.fn(
      overrides.coordsAtPos ??
        ((_pos: number, side = 1) =>
          rows
            ? ({
                top: side < 0 ? rows.before : rows.after,
                bottom: 0,
                left: 0,
                right: 0,
              } as DOMRect)
            : null),
    ),
    state: { doc: { length: line.to, lineAt: () => line } },
  } as unknown as EditorView & { posAtCoords: ReturnType<typeof vi.fn> };
}

describe('positionBelowText', () => {
  it('uses the note end at exactly two rows below the final row', () => {
    document.body.innerHTML =
      '<div class="cm-scroller"><div class="cm-content"><div class="cm-line">alpha bravo</div></div></div>';
    const scroller = document.querySelector('.cm-scroller') as HTMLElement;
    const content = document.querySelector('.cm-content') as HTMLElement;
    const line = document.querySelector('.cm-line') as HTMLElement;
    scroller.getBoundingClientRect = () =>
      ({ left: 0, right: 400, top: 0, bottom: 500 }) as DOMRect;
    content.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 120 }) as DOMRect;
    Range.prototype.getClientRects = () =>
      [{ left: 0, right: 200, top: 100, bottom: 120 }] as unknown as DOMRectList;
    const view = fakeView({
      line: { from: 0, to: 11 },
      posAtCoords: () => 2,
      coordsAtPos: () => ({ top: 100, bottom: 120, left: 200, right: 200 }) as DOMRect,
    });
    Object.assign(view, {
      contentDOM: content,
      defaultLineHeight: 20,
      domAtPos: () => ({ node: line, offset: 0 }),
      scrollDOM: scroller,
    });

    expect(positionBelowText(20, 160, view)?.head).toBe(11);
  });
});

describe('resolveTapPositionAt', () => {
  let hitElement: Element | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div class="cm-content"><div class="cm-line">last one</div></div>';
    document.elementFromPoint = () => hitElement;
    // jsdom lays nothing out, and the tap's y is clamped into the line's box —
    // a zero rect would clamp every tap to the same point.
    const line = document.querySelector('.cm-line') as HTMLElement;
    line.getBoundingClientRect = () => ({ top: 130, bottom: 200, left: 40, right: 400 }) as DOMRect;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  });

  it('has no answer for a tap that is not on a line', () => {
    hitElement = document.querySelector('.cm-content');
    const view = fakeView({});

    expect(resolveTapPositionAt(46, 107, view, hitElement)).toBeNull();
    expect(view.posAtCoords).not.toHaveBeenCalled();
  });

  it('answers the tapped position for a tap on a line', () => {
    hitElement = document.querySelector('.cm-line');
    const view = fakeView({ posAtCoords: () => 26 });

    expect(resolveTapPositionAt(46, 90, view, hitElement)?.head).toBe(26);
  });

  // Blink drops to position 0 on a line with no text of its own.
  it('answers the line start for a tap on an empty line', () => {
    hitElement = document.querySelector('.cm-line');
    const view = fakeView({ line: { from: 12, to: 12 }, posAtCoords: () => 0 });

    expect(resolveTapPositionAt(46, 90, view, hitElement)?.head).toBe(12);
  });

  it('answers the visual row end before posAtCoords can land inside hidden trailing markup', () => {
    hitElement = document.querySelector('.cm-line');
    const line = hitElement as HTMLElement;
    const visible = document.createElement('span');
    visible.className = 'cm-md-link';
    visible.getClientRects = () =>
      [{ left: 40, right: 100, top: 130, bottom: 200 }] as unknown as DOMRectList;
    line.appendChild(visible);
    const view = fakeView({
      line: { from: 23, to: 31 },
      posAtCoords: () => 30,
      coordsAtPos: (position) =>
        position === 31 ? ({ top: 130, bottom: 200, left: 100, right: 100 } as DOMRect) : null,
    });

    expect(resolveTapPositionAt(200, 160, view, hitElement)?.head).toBe(31);
    expect(view.posAtCoords).not.toHaveBeenCalled();
  });

  describe('at a wrap point, the association follows the tapped row', () => {
    // The position draws at y=140 (end of row 1) or y=170 (start of row 2).
    const wrapped = () => fakeView({ posAtCoords: () => 26, rowTops: { before: 140, after: 170 } });

    it('holds the caret on the upper row for a tap there', () => {
      hitElement = document.querySelector('.cm-line');
      expect(resolveTapPositionAt(46, 150, wrapped(), hitElement)?.assoc).toBe(-1);
    });

    it('holds the caret on the lower row for a tap there', () => {
      hitElement = document.querySelector('.cm-line');
      expect(resolveTapPositionAt(46, 180, wrapped(), hitElement)?.assoc).toBe(1);
    });

    it('leaves the association alone where the position draws in one place', () => {
      hitElement = document.querySelector('.cm-line');
      const view = fakeView({ posAtCoords: () => 26, rowTops: { before: 140, after: 140 } });
      expect(resolveTapPositionAt(46, 150, view, hitElement)?.assoc).toBe(0);
    });
  });
});
