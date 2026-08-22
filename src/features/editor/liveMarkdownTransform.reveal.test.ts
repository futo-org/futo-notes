import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  clearMarkdownSelectionReveal,
  createSelectionRevealSnapshot,
  freezeMarkdownSelectionReveal,
  markdownSelectionRevealState,
  suppressMarkdownSelectionReveal,
} from './live-preview/selectionReveal';
import {
  getCursorLinesForReveal,
  isBlockRevealSensitive,
  isInlineRevealSensitive,
  selectionTouchesRange,
  selectionWithinMarkerRange,
  shouldHideHeaderTagBlock,
  shouldSkipBlockDecorations,
  shouldSkipInlineDecorations,
} from './liveMarkdownTransform';

function revealState(): EditorState {
  return EditorState.create({ doc: 'one\ntwo\nthree', extensions: markdownSelectionRevealState });
}

describe('live markdown selection reveal', () => {
  it('computes active cursor lines only when focused', () => {
    const doc = revealState().doc;
    expect(getCursorLinesForReveal(false, [{ from: 1, to: 1 }], doc)).toEqual(new Set());
    expect(
      getCursorLinesForReveal(
        true,
        [
          { from: 1, to: 1 },
          { from: 5, to: 5 },
        ],
        doc,
      ),
    ).toEqual(new Set([1, 2]));
  });

  it('classifies reveal-sensitive markdown nodes', () => {
    expect(isBlockRevealSensitive('HorizontalRule')).toBe(true);
    expect(isBlockRevealSensitive('Emphasis')).toBe(false);
    expect(isInlineRevealSensitive('Link')).toBe(true);
    expect(isInlineRevealSensitive('Image')).toBe(true);
    expect(isInlineRevealSensitive('StrongEmphasis')).toBe(false);
  });

  it('uses the editor focus and selection when no pointer gesture is active', () => {
    const state = revealState();
    expect(selectionTouchesRange(state, false, [{ from: 3, to: 3 }], 2, 4)).toBe(false);
    expect(selectionTouchesRange(state, true, [{ from: 3, to: 3 }], 2, 4)).toBe(true);
    expect(selectionTouchesRange(state, true, [{ from: 1, to: 7 }], 5, 8)).toBe(true);
    expect(selectionTouchesRange(state, true, [{ from: 1, to: 1 }], 5, 8)).toBe(false);
  });

  it('keeps the pointer-down ranges effective while drag rebuilding is suppressed', () => {
    let state = revealState();
    state = state.update({
      effects: [
        freezeMarkdownSelectionReveal.of(createSelectionRevealSnapshot(true, [{ from: 3, to: 3 }])),
        suppressMarkdownSelectionReveal.of(true),
      ],
    }).state;

    expect(selectionTouchesRange(state, true, [{ from: 8, to: 10 }], 2, 4)).toBe(true);
    expect(selectionTouchesRange(state, true, [{ from: 8, to: 10 }], 8, 10)).toBe(false);

    state = state.update({ effects: clearMarkdownSelectionReveal.of(null) }).state;
    expect(selectionTouchesRange(state, true, [{ from: 8, to: 10 }], 8, 10)).toBe(false);
  });

  it('skips block and inline decorations only for the active cursor context', () => {
    const state = revealState();
    const cursorLines = new Set([2]);
    expect(shouldSkipBlockDecorations('ATXHeading2', 2, cursorLines)).toBe(true);
    expect(shouldSkipBlockDecorations('ATXHeading2', 1, cursorLines)).toBe(false);
    expect(shouldSkipInlineDecorations('Link', state, 2, 4, true, [{ from: 3, to: 3 }])).toBe(true);
    expect(shouldSkipInlineDecorations('Link', state, 2, 4, false, [{ from: 3, to: 3 }])).toBe(
      false,
    );
    expect(shouldSkipInlineDecorations('Emphasis', state, 2, 4, true, [{ from: 3, to: 3 }])).toBe(
      false,
    );
  });

  it('hides header tag blocks only when the cursor is outside the block', () => {
    expect(shouldHideHeaderTagBlock(2, new Set([3]))).toBe(true);
    expect(shouldHideHeaderTagBlock(2, new Set([2]))).toBe(false);
  });

  it('reveals list markers only while the effective selection overlaps their source', () => {
    const state = revealState();
    const within = (from: number, to: number, markerTo = 6) =>
      selectionWithinMarkerRange(state, true, [{ from, to }], 0, markerTo);

    for (const position of [0, 1, 2, 3, 4, 5]) expect(within(position, position)).toBe(true);
    expect(within(6, 6)).toBe(false);
    expect(within(3, 9)).toBe(true);
    expect(within(6, 9)).toBe(false);
    expect(selectionWithinMarkerRange(state, false, [{ from: 1, to: 1 }], 0, 2)).toBe(false);
  });
});
