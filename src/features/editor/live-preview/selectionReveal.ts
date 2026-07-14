import type { EditorView } from '@codemirror/view';

export interface SelectionRangeLike {
  from: number;
  to: number;
}

interface LineNumberLookup {
  lineAt(position: number): { number: number };
}

let suppressReveal = false;
let frozenReveal: { hasFocus: boolean; ranges: readonly SelectionRangeLike[] } | null = null;

export function setSuppressSelectionReveal(suppress: boolean): void {
  suppressReveal = suppress;
}

export function isMarkdownSelectionRevealSuppressed(): boolean {
  return suppressReveal;
}

export function freezeSelectionReveal(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): void {
  frozenReveal = { hasFocus, ranges: ranges.map(({ from, to }) => ({ from, to })) };
}

export function clearSelectionRevealFreeze(): void {
  frozenReveal = null;
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
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  const effectiveRanges = getEffectiveRanges(hasFocus, ranges);
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
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  markerStart: number,
  contentStart: number,
): boolean {
  const effectiveRanges = getEffectiveRanges(hasFocus, ranges);
  if (!effectiveRanges) return false;
  return effectiveRanges.some((range) =>
    range.from === range.to
      ? range.from >= markerStart && range.from < contentStart
      : range.from < contentStart && range.to > markerStart,
  );
}

export function shouldRevealMarkdownSyntax(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number,
): boolean {
  return selectionTouchesRange(hasFocus, ranges, from, to);
}

export function shouldRevealInlineMarkers(view: EditorView, from: number, to: number): boolean {
  return selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);
}

export function shouldSkipBlockDecorations(
  nodeName: string,
  line: number,
  cursorLines: Set<number>,
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  fromOrLine: number,
  toOrCursorLines: number | Set<number>,
  hasFocus = false,
  ranges: readonly SelectionRangeLike[] = [],
): boolean {
  if (!isBlockRevealSensitive(nodeName)) return false;
  if (toOrCursorLines instanceof Set) return toOrCursorLines.has(fromOrLine);
  return shouldRevealMarkdownSyntax(hasFocus, ranges, fromOrLine, toOrCursorLines);
}

export function shouldSkipInlineDecorations(
  nodeName: string,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): boolean {
  return isInlineRevealSensitive(nodeName) && selectionTouchesRange(hasFocus, ranges, from, to);
}

export function shouldHideHeaderTagBlock(blockLastLine: number, cursorLines: Set<number>): boolean {
  for (let line = 1; line <= blockLastLine; line += 1) {
    if (cursorLines.has(line)) return false;
  }
  return true;
}

function getEffectiveRanges(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
): readonly SelectionRangeLike[] | null {
  if (frozenReveal) return frozenReveal.hasFocus ? frozenReveal.ranges : null;
  if (suppressReveal || !hasFocus) return null;
  return ranges;
}
