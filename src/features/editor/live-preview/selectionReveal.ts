import {
  EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type SelectionRange,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export interface SelectionRangeLike {
  from: number;
  to: number;
}

interface LineNumberLookup {
  lineAt(position: number): { number: number };
}

interface FrozenSelectionReveal {
  hasFocus: boolean;
  ranges: readonly SelectionRange[];
}

interface SelectionRevealValue {
  frozen: FrozenSelectionReveal | null;
  suppressed: boolean;
}

/** Freezes markdown selection reveal at the current selection until the pointer gesture settles. */
export const freezeMarkdownSelectionReveal = StateEffect.define<FrozenSelectionReveal>();

/** Clears a markdown selection reveal snapshot after a pointer gesture settles. */
export const clearMarkdownSelectionReveal = StateEffect.define<null>();

/** Suppresses selection-driven decoration rebuilding while a desktop pointer drag is active. */
export const suppressMarkdownSelectionReveal = StateEffect.define<boolean>();

/** Per-editor markdown selection reveal state shared by live preview and pointer interactions. */
export const markdownSelectionRevealState = StateField.define<SelectionRevealValue>({
  create: () => ({ frozen: null, suppressed: false }),
  update(value, transaction) {
    let frozen = value.frozen;
    let suppressed = value.suppressed;
    let changed = false;

    if (frozen && transaction.docChanged) {
      frozen = {
        ...frozen,
        ranges: frozen.ranges.map((range) => range.map(transaction.changes)),
      };
      changed = true;
    }

    for (const effect of transaction.effects) {
      if (effect.is(freezeMarkdownSelectionReveal)) {
        frozen = effect.value;
        changed = true;
      } else if (effect.is(clearMarkdownSelectionReveal)) {
        frozen = null;
        changed = true;
      } else if (effect.is(suppressMarkdownSelectionReveal)) {
        suppressed = effect.value;
        changed = true;
      }
    }
    return changed ? { frozen, suppressed } : value;
  },
});

/** Creates a detached selection snapshot suitable for freezeMarkdownSelectionReveal. */
export function createSelectionRevealSnapshot(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): FrozenSelectionReveal {
  return {
    hasFocus,
    ranges: ranges.map(({ from, to }) => EditorSelection.range(from, to)),
  };
}

/** True when selection-driven decoration rebuilding is suppressed for this editor state. */
export function isMarkdownSelectionRevealSuppressed(state: EditorState): boolean {
  return state.field(markdownSelectionRevealState, false)?.suppressed ?? false;
}

export function getCursorLinesForReveal(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  doc: LineNumberLookup,
): Set<number> {
  if (!hasFocus) return new Set();
  return new Set(ranges.map((range) => doc.lineAt(range.from).number));
}

export function isBlockRevealSensitive(nodeName: string): boolean {
  return /^(ATXHeading|FencedCode|CodeBlock|HorizontalRule)/.test(nodeName);
}

export function isInlineRevealSensitive(nodeName: string): boolean {
  return /^(Link|Image|Task)/.test(nodeName);
}

export function selectionTouchesRange(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  const effectiveRanges = getEffectiveRanges(state, hasFocus, ranges);
  return effectiveRanges !== null && selectionIntersectsRange(effectiveRanges, from, to);
}

export function selectionIntersectsRange(
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return ranges.some((range) =>
    range.from === range.to
      ? range.from >= from && range.from <= to
      : range.from < to && range.to > from,
  );
}

export function selectionWithinMarkerRange(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  markerStart: number,
  contentStart: number,
): boolean {
  const effectiveRanges = getEffectiveRanges(state, hasFocus, ranges);
  if (!effectiveRanges) return false;
  return effectiveRanges.some((range) =>
    range.from === range.to
      ? range.from >= markerStart && range.from < contentStart
      : range.from < contentStart && range.to > markerStart,
  );
}

export function shouldRevealMarkdownSyntax(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return selectionTouchesRange(state, hasFocus, ranges, from, to);
}

export function shouldRevealInlineMarkers(view: EditorView, from: number, to: number): boolean {
  return selectionTouchesRange(view.state, view.hasFocus, view.state.selection.ranges, from, to);
}

export function shouldSkipBlockDecorations(
  nodeName: string,
  line: number,
  cursorLines: Set<number>,
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  state: EditorState,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  lineOrState: number | EditorState,
  fromOrCursorLines: number | Set<number>,
  to = 0,
  hasFocus = false,
  ranges: readonly SelectionRangeLike[] = [],
): boolean {
  if (!isBlockRevealSensitive(nodeName)) return false;
  if (typeof lineOrState === 'number') {
    return (fromOrCursorLines as Set<number>).has(lineOrState);
  }
  return shouldRevealMarkdownSyntax(lineOrState, hasFocus, ranges, fromOrCursorLines as number, to);
}

export function shouldSkipInlineDecorations(
  nodeName: string,
  state: EditorState,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): boolean {
  return (
    isInlineRevealSensitive(nodeName) && selectionTouchesRange(state, hasFocus, ranges, from, to)
  );
}

export function shouldHideHeaderTagBlock(blockLastLine: number, cursorLines: Set<number>): boolean {
  for (let line = 1; line <= blockLastLine; line += 1) {
    if (cursorLines.has(line)) return false;
  }
  return true;
}

function getEffectiveRanges(
  state: EditorState,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): readonly SelectionRangeLike[] | null {
  const reveal = state.field(markdownSelectionRevealState, false);
  if (reveal?.frozen) return reveal.frozen.hasFocus ? reveal.frozen.ranges : null;
  if (reveal?.suppressed || !hasFocus) return null;
  return ranges;
}
