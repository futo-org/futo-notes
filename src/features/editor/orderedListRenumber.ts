import { Annotation } from '@codemirror/state';
import type { ChangeSpec, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

const ORDERED_LINE_RE = /^(\s*)(\d+)\.\s/;
const renumberAnnotation = Annotation.define<true>();

function findOrderedBlockStart(doc: Text, lineNumber: number, indent: string): number {
  let start = lineNumber;
  while (start > 1) {
    const previous = doc.line(start - 1).text.match(ORDERED_LINE_RE);
    if (!previous || previous[1] !== indent) break;
    start -= 1;
  }
  return start;
}

export function computeOrderedRenumberChanges(
  doc: Text,
  affectedLines: Iterable<number>,
): ChangeSpec[] {
  const blockStarts = new Set<number>();
  for (const lineNumber of affectedLines) {
    if (lineNumber < 1 || lineNumber > doc.lines) continue;
    let probe = lineNumber;
    let match = doc.line(probe).text.match(ORDERED_LINE_RE);
    if (!match && probe > 1) {
      probe -= 1;
      match = doc.line(probe).text.match(ORDERED_LINE_RE);
    }
    if (match) blockStarts.add(findOrderedBlockStart(doc, probe, match[1]));
  }

  const changes: ChangeSpec[] = [];
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

export const orderedListRenumber = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (update.transactions.some((transaction) => transaction.annotation(renumberAnnotation))) return;

  const affectedLines = new Set<number>();
  const newDocument = update.state.doc;
  for (const transaction of update.transactions) {
    transaction.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      const startLine = newDocument.lineAt(fromB).number;
      const endLine = newDocument.lineAt(toB).number;
      for (let line = startLine; line <= endLine; line += 1) affectedLines.add(line);
      if (startLine > 1) affectedLines.add(startLine - 1);
    });
  }

  const changes = computeOrderedRenumberChanges(newDocument, affectedLines);
  if (changes.length === 0) return;
  update.view.dispatch({
    changes,
    annotations: renumberAnnotation.of(true),
    userEvent: 'input.renumber',
  });
});
