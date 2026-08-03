import type { Line, Text } from '@codemirror/state';

/** A half-open character span of the document, in CM6 `from`/`to` offsets. */
export interface DocumentRange {
  from: number;
  to: number;
}

/**
 * Converts the viewport's visible ranges into clamped, line-expanded, merged
 * scan ranges — the bounds every per-keystroke decoration scan must stay
 * within so typing cost never grows with document size.
 */
export function getViewportScanRanges(
  doc: Text,
  visibleRanges: readonly DocumentRange[],
): DocumentRange[] {
  const lineRanges = visibleRanges
    .map(({ from, to }) => {
      const clampedFrom = Math.max(0, Math.min(from, doc.length));
      const clampedTo = Math.max(clampedFrom, Math.min(to, doc.length));
      return {
        from: doc.lineAt(clampedFrom).from,
        to: doc.lineAt(clampedTo).to,
      };
    })
    .sort((left, right) => left.from - right.from);

  const mergedRanges: DocumentRange[] = [];
  for (const range of lineRanges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (previous && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      mergedRanges.push({ ...range });
    }
  }
  return mergedRanges;
}

/** Visits every document line that overlaps the given scan ranges, in order. */
export function forEachLineInRanges(
  doc: Text,
  ranges: readonly DocumentRange[],
  visit: (line: Line) => void,
): void {
  for (const range of ranges) {
    const firstLine = doc.lineAt(range.from).number;
    const lastLine = doc.lineAt(range.to).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      visit(doc.line(lineNumber));
    }
  }
}
