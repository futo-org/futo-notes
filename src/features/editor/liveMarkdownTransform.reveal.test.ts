import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSelectionRevealFreeze,
  freezeSelectionReveal,
  getCursorLinesForReveal,
  isBlockRevealSensitive,
  isInlineRevealSensitive,
  selectionTouchesRange,
  selectionWithinMarkerRange,
  setSuppressSelectionReveal,
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
  afterEach(() => {
    clearSelectionRevealFreeze();
    setSuppressSelectionReveal(false);
  });

  it('computes active cursor lines only when focused', () => {
    expect(getCursorLinesForReveal(false, [{ from: 1, to: 1 }], mockDoc)).toEqual(new Set());
    expect(
      getCursorLinesForReveal(
        true,
        [
          { from: 1, to: 1 },
          { from: 6, to: 6 },
        ],
        mockDoc,
      ),
    ).toEqual(new Set([1, 2]));
  });

  it('classifies block and inline reveal-sensitive nodes', () => {
    expect(isBlockRevealSensitive('HorizontalRule')).toBe(true);
    expect(isBlockRevealSensitive('Emphasis')).toBe(false);
    expect(isInlineRevealSensitive('Link')).toBe(true);
    expect(isInlineRevealSensitive('Image')).toBe(true);
    expect(isInlineRevealSensitive('StrongEmphasis')).toBe(false);
    expect(isInlineRevealSensitive('ListItem')).toBe(false);
  });

  it('detects when the selection touches a decorated range', () => {
    expect(selectionTouchesRange(false, [{ from: 3, to: 3 }], 2, 4)).toBe(false);
    expect(selectionTouchesRange(true, [{ from: 3, to: 3 }], 2, 4)).toBe(true);
    expect(selectionTouchesRange(true, [{ from: 1, to: 7 }], 5, 8)).toBe(true);
    expect(selectionTouchesRange(true, [{ from: 1, to: 1 }], 5, 8)).toBe(false);
  });

  it('keeps pointer-down reveal state stable during drag suppression', () => {
    freezeSelectionReveal(true, [{ from: 3, to: 3 }]);
    setSuppressSelectionReveal(true);

    expect(selectionTouchesRange(true, [{ from: 8, to: 10 }], 2, 4)).toBe(true);
    expect(selectionTouchesRange(true, [{ from: 8, to: 10 }], 8, 10)).toBe(false);
  });

  it('skips block and inline decorations only for active cursor context', () => {
    const cursorLines = new Set([2]);
    expect(shouldSkipBlockDecorations('ATXHeading2', 2, cursorLines)).toBe(true);
    expect(shouldSkipBlockDecorations('ATXHeading2', 1, cursorLines)).toBe(false);
    expect(shouldSkipInlineDecorations('Link', 2, 4, true, [{ from: 3, to: 3 }])).toBe(true);
    expect(shouldSkipInlineDecorations('Link', 2, 4, false, [{ from: 3, to: 3 }])).toBe(false);
    expect(shouldSkipInlineDecorations('Emphasis', 2, 4, true, [{ from: 3, to: 3 }])).toBe(false);
  });

  it('hides header tag blocks only when the cursor is outside the block', () => {
    expect(shouldHideHeaderTagBlock(2, new Set([3]))).toBe(true);
    expect(shouldHideHeaderTagBlock(2, new Set([2]))).toBe(false);
  });

  describe('selectionWithinMarkerRange (list/task marker reveal)', () => {
    it('reveals a bullet `- ` marker (range 0..2) only at ch 0 and 1', () => {
      const within = (ch: number) => selectionWithinMarkerRange(true, [{ from: ch, to: ch }], 0, 2);
      expect(within(0)).toBe(true); // on the dash
      expect(within(1)).toBe(true); // between dash and space
      expect(within(2)).toBe(false); // content start → render bullet
      expect(within(7)).toBe(false); // deep in the word → render bullet
    });

    it('reveals a task `- [ ] ` marker (range 0..6) for ch 0..5, renders at 6+', () => {
      const within = (ch: number) => selectionWithinMarkerRange(true, [{ from: ch, to: ch }], 0, 6);
      for (const ch of [0, 1, 2, 3, 4, 5]) expect(within(ch)).toBe(true);
      expect(within(6)).toBe(false); // content start → render checkbox
      expect(within(9)).toBe(false); // in the word → render checkbox
    });

    it('does not reveal when the editor is unfocused', () => {
      expect(selectionWithinMarkerRange(false, [{ from: 1, to: 1 }], 0, 2)).toBe(false);
    });

    it('reveals when a non-empty selection overlaps the marker (half-open)', () => {
      expect(selectionWithinMarkerRange(true, [{ from: 3, to: 9 }], 0, 6)).toBe(true);
      expect(selectionWithinMarkerRange(true, [{ from: 6, to: 9 }], 0, 6)).toBe(false);
    });

    it('suppresses reveal during an active mouse drag', () => {
      setSuppressSelectionReveal(true);
      expect(selectionWithinMarkerRange(true, [{ from: 1, to: 1 }], 0, 2)).toBe(false);
    });

    it('uses frozen selection ranges while frozen', () => {
      freezeSelectionReveal(true, [{ from: 1, to: 1 }]);
      expect(selectionWithinMarkerRange(true, [{ from: 7, to: 7 }], 0, 2)).toBe(true);
    });
  });
});
