import { EditorSelection, EditorState } from '@codemirror/state';
import type { Text } from '@codemirror/state';

const ORDERED_LINE_RE = /^(\s*)(\d+)\.\s/;
const BLANK_LINE_RE = /\n[ \t]*\n/;

export interface RenumberEdit {
  from: number;
  to: number;
  insert: string;
}

interface ResolvedBlockStart {
  line: number;
  indent: string | null;
  start: number;
}

function findOrderedBlockStart(
  doc: Text,
  lineNumber: number,
  indent: string,
  resolved: ResolvedBlockStart,
): number {
  let start = lineNumber;
  while (true) {
    // Landing on an already-resolved line means the rest of this walk retraces it.
    if (start === resolved.line && resolved.indent === indent) return resolved.start;
    if (start <= 1) return start;
    const previous = doc.line(start - 1).text.match(ORDERED_LINE_RE);
    if (!previous || previous[1] !== indent) return start;
    start -= 1;
  }
}

// Ascending order is load-bearing: it lets each walk stop where the previous one
// landed, so one edit touching a whole list reads each line once instead of
// walking back from every line.
function collectOrderedBlockStarts(doc: Text, affectedLines: Iterable<number>): Set<number> {
  const probeLines = [...new Set(affectedLines)]
    .filter((lineNumber) => lineNumber >= 1 && lineNumber <= doc.lines)
    .sort((left, right) => left - right);

  const blockStarts = new Set<number>();
  const resolved: ResolvedBlockStart = { line: -1, indent: null, start: -1 };

  for (const lineNumber of probeLines) {
    let probe = lineNumber;
    let match = doc.line(probe).text.match(ORDERED_LINE_RE);
    if (!match && probe > 1) {
      probe -= 1;
      match = doc.line(probe).text.match(ORDERED_LINE_RE);
    }
    if (!match) continue;

    const indent = match[1];
    const start = findOrderedBlockStart(doc, probe, indent, resolved);
    resolved.line = probe;
    resolved.indent = indent;
    resolved.start = start;
    blockStarts.add(start);
  }
  return blockStarts;
}

export function computeOrderedRenumberChanges(
  doc: Text,
  affectedLines: Iterable<number>,
): RenumberEdit[] {
  const blockStarts = collectOrderedBlockStarts(doc, affectedLines);

  const changes: RenumberEdit[] = [];
  for (const startLineNumber of blockStarts) {
    const startLine = doc.line(startLineNumber);
    const startMatch = startLine.text.match(ORDERED_LINE_RE);
    if (!startMatch) continue;
    const indent = startMatch[1];
    const startNumber = parseInt(startMatch[2], 10);

    let offset = 0;
    let lineNumber = startLineNumber;
    while (lineNumber <= doc.lines) {
      const line = doc.line(lineNumber);
      const match = line.text.match(ORDERED_LINE_RE);
      if (!match || match[1] !== indent) break;
      const expected = String(startNumber + offset);
      if (match[2] !== expected) {
        const numberStart = line.from + indent.length;
        changes.push({
          from: numberStart,
          to: numberStart + match[2].length,
          insert: expected,
        });
      }
      offset += 1;
      lineNumber += 1;
    }
  }
  return changes;
}

/**
 * Merges the per-line edits into one change per list block — carrying one change
 * range per item instead measures ~1.7x slower on desktop. Text between merged
 * edits is carried over verbatim; a blank line ends a block and so ends a merge.
 */
export function coalesceRenumberEdits(doc: Text, edits: readonly RenumberEdit[]): RenumberEdit[] {
  const coalesced: RenumberEdit[] = [];

  for (const edit of [...edits].sort((left, right) => left.from - right.from)) {
    const open = coalesced[coalesced.length - 1];
    const between = open ? doc.sliceString(open.to, edit.from) : '';
    if (open && !BLANK_LINE_RE.test(between)) {
      open.insert += between + edit.insert;
      open.to = edit.to;
    } else {
      coalesced.push({ ...edit });
    }
  }
  return coalesced;
}

// Mapped against the per-line edits, not the merged ones: CodeMirror would drop a
// caret inside a merged span to its edge, and digit-width edits pin it exactly.
function mapPositionThroughEdits(position: number, edits: readonly RenumberEdit[]): number {
  let delta = 0;
  for (const edit of edits) {
    if (edit.from >= position) break;
    const growth = edit.insert.length - (edit.to - edit.from);
    if (edit.to <= position) {
      delta += growth;
      continue;
    }
    // Between digits of a rewritten number — the one spot CodeMirror would
    // disagree, associating before it. Follow the digits instead.
    return edit.from + delta + edit.insert.length;
  }
  return position + delta;
}

// A filter, not an update listener: the renumber must join the transaction that
// triggered it, and undo/redo dispatch with `filter: false` so they never re-run it.
export const orderedListRenumber = EditorState.transactionFilter.of((transaction) => {
  if (!transaction.docChanged) return transaction;

  const affectedLines = new Set<number>();
  const newDocument = transaction.newDoc;
  transaction.changes.iterChanges((_fromA, _toA, fromB, toB) => {
    const startLine = newDocument.lineAt(fromB).number;
    const endLine = newDocument.lineAt(toB).number;
    for (let line = startLine; line <= endLine; line += 1) affectedLines.add(line);
    if (startLine > 1) affectedLines.add(startLine - 1);
  });

  const edits = computeOrderedRenumberChanges(newDocument, affectedLines);
  if (edits.length === 0) return transaction;
  const selection = transaction.newSelection;
  // `sequential` resolves the changes against the post-transaction document; the
  // selection resolves against the final document, hence the explicit mapping.
  return [
    transaction,
    {
      changes: coalesceRenumberEdits(newDocument, edits),
      sequential: true,
      selection: EditorSelection.create(
        selection.ranges.map((range) =>
          EditorSelection.range(
            mapPositionThroughEdits(range.anchor, edits),
            mapPositionThroughEdits(range.head, edits),
          ),
        ),
        selection.mainIndex,
      ),
    },
  ];
});
