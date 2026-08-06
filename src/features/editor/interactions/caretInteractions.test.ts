// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';

import { EditorCaretInteractions } from './caretInteractions';

function fakeView(overrides: {
  posAtCoords?: (coords: { x: number; y: number }) => number | null;
  posAtDOM?: () => number;
  line?: { from: number; to: number };
  /** Row tops the position draws at, per association. */
  rowTops?: { before: number; after: number };
}) {
  const line = overrides.line ?? { from: 23, to: 31 };
  const rows = overrides.rowTops;
  return {
    posAtCoords: vi.fn(overrides.posAtCoords ?? (() => 26)),
    posAtDOM: vi.fn(overrides.posAtDOM ?? (() => line.from)),
    coordsAtPos: vi.fn((_pos: number, side = 1) =>
      rows ? { top: side < 0 ? rows.before : rows.after, bottom: 0, left: 0, right: 0 } : null,
    ),
    state: { doc: { lineAt: () => line } },
  } as unknown as EditorView & { posAtCoords: ReturnType<typeof vi.fn> };
}

function interactions() {
  return new EditorCaretInteractions({
    nativeShell: true,
    isIOS: false,
    getView: () => null,
    hasPendingExternalLink: () => false,
  });
}

describe('resolveTapPositionAt', () => {
  let hitElement: Element | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div class="cm-content"><div class="cm-line">last one</div></div>';
    document.elementFromPoint = () => hitElement;
    // jsdom lays nothing out, and the tap's y is clamped into the line's box —
    // a zero rect would clamp every tap to the same point.
    const line = document.querySelector('.cm-line') as HTMLElement;
    line.getBoundingClientRect = () => ({ top: 130, bottom: 200, left: 40, right: 400 }) as DOMRect;
  });

  it('has no answer for a tap that is not on a line', () => {
    hitElement = document.querySelector('.cm-content');
    const view = fakeView({});

    expect(interactions().resolveTapPositionAt(46, 107, view, hitElement)).toBeNull();
    expect(view.posAtCoords).not.toHaveBeenCalled();
  });

  it('answers the tapped position for a tap on a line', () => {
    hitElement = document.querySelector('.cm-line');
    const view = fakeView({ posAtCoords: () => 26 });

    expect(interactions().resolveTapPositionAt(46, 90, view, hitElement)?.head).toBe(26);
  });

  // Blink drops to position 0 on a line with no text of its own.
  it('answers the line start for a tap on an empty line', () => {
    hitElement = document.querySelector('.cm-line');
    const view = fakeView({ line: { from: 12, to: 12 }, posAtCoords: () => 0 });

    expect(interactions().resolveTapPositionAt(46, 90, view, hitElement)?.head).toBe(12);
  });

  describe('at a wrap point, the association follows the tapped row', () => {
    // The position draws at y=140 (end of row 1) or y=170 (start of row 2).
    const wrapped = () => fakeView({ posAtCoords: () => 26, rowTops: { before: 140, after: 170 } });

    it('holds the caret on the upper row for a tap there', () => {
      hitElement = document.querySelector('.cm-line');
      expect(interactions().resolveTapPositionAt(46, 150, wrapped(), hitElement)?.assoc).toBe(-1);
    });

    it('holds the caret on the lower row for a tap there', () => {
      hitElement = document.querySelector('.cm-line');
      expect(interactions().resolveTapPositionAt(46, 180, wrapped(), hitElement)?.assoc).toBe(1);
    });

    it('leaves the association alone where the position draws in one place', () => {
      hitElement = document.querySelector('.cm-line');
      const view = fakeView({ posAtCoords: () => 26, rowTops: { before: 140, after: 140 } });
      expect(interactions().resolveTapPositionAt(46, 150, view, hitElement)?.assoc).toBe(0);
    });
  });
});
