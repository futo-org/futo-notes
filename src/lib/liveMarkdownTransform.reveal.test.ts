import { describe, expect, it } from 'vitest';
import {
  getCursorLinesForReveal,
  isBlockRevealSensitive,
  isInlineRevealSensitive,
  selectionTouchesRange,
  shouldHideHeaderTagBlock,
  shouldSkipBlockDecorations,
  shouldSkipInlineDecorations,
} from './liveMarkdownTransform';

const mockDoc = {
  lineAt(pos: number) {
    if (pos < 5) return { number: 1 };
    if (pos < 10) return { number: 2 };
    return { number: 3 };
  },
};

describe('liveMarkdownTransform reveal helpers', () => {
  it('computes active cursor lines only when focused', () => {
    expect(getCursorLinesForReveal(false, [{ from: 1, to: 1 }], mockDoc)).toEqual(new Set());
    expect(getCursorLinesForReveal(true, [{ from: 1, to: 1 }, { from: 6, to: 6 }], mockDoc))
      .toEqual(new Set([1, 2]));
  });

  it('classifies block and inline reveal-sensitive nodes', () => {
    expect(isBlockRevealSensitive('HorizontalRule')).toBe(true);
    expect(isBlockRevealSensitive('Emphasis')).toBe(false);
    expect(isInlineRevealSensitive('StrongEmphasis')).toBe(true);
    expect(isInlineRevealSensitive('ListItem')).toBe(false);
  });

  it('detects when the selection touches a decorated range', () => {
    expect(selectionTouchesRange(false, [{ from: 3, to: 3 }], 2, 4)).toBe(false);
    expect(selectionTouchesRange(true, [{ from: 3, to: 3 }], 2, 4)).toBe(true);
    expect(selectionTouchesRange(true, [{ from: 1, to: 7 }], 5, 8)).toBe(true);
    expect(selectionTouchesRange(true, [{ from: 1, to: 1 }], 5, 8)).toBe(false);
  });

  it('skips block and inline decorations only for active cursor context', () => {
    const cursorLines = new Set([2]);
    expect(shouldSkipBlockDecorations('ATXHeading2', 2, cursorLines)).toBe(true);
    expect(shouldSkipBlockDecorations('ATXHeading2', 1, cursorLines)).toBe(false);
    expect(shouldSkipInlineDecorations('Emphasis', 2, 4, true, [{ from: 3, to: 3 }])).toBe(true);
    expect(shouldSkipInlineDecorations('Emphasis', 2, 4, false, [{ from: 3, to: 3 }])).toBe(false);
  });

  it('hides header tag blocks only when the cursor is outside the block', () => {
    expect(shouldHideHeaderTagBlock(2, new Set([3]))).toBe(true);
    expect(shouldHideHeaderTagBlock(2, new Set([2]))).toBe(false);
  });
});
