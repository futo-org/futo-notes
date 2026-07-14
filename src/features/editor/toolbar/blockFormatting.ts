import type { EditorView } from '@codemirror/view';

const BULLET_RE = /^- /;
const ORDERED_RE = /^\d+\. /;
const TASK_RE = /^- \[([ x])\] /;
const HEADING_RE = /^(#{1,3}) /;
const QUOTE_RE = /^> /;
const ALL_LINE_PREFIXES = [BULLET_RE, ORDERED_RE, TASK_RE, HEADING_RE, QUOTE_RE];

export function isListLine(text: string): boolean {
  const trimmed = text.trimStart();
  return BULLET_RE.test(trimmed) || ORDERED_RE.test(trimmed) || TASK_RE.test(trimmed);
}

function toggleLinePrefix(
  view: EditorView,
  prefix: string,
  matchPrefix: (lineText: string) => RegExpMatchArray | null,
): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const changes: { from: number; to: number; insert: string }[] = [];
  let selectionDelta = 0;

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const match = matchPrefix(line.text);
    if (match) {
      changes.push({ from: line.from, to: line.from + match[0].length, insert: '' });
      if (lineNumber === startLine.number) selectionDelta = -match[0].length;
      continue;
    }

    const otherMatch = ALL_LINE_PREFIXES.map((pattern) => line.text.match(pattern)).find(Boolean);
    if (otherMatch) {
      changes.push({ from: line.from, to: line.from + otherMatch[0].length, insert: prefix });
      if (lineNumber === startLine.number) selectionDelta = prefix.length - otherMatch[0].length;
    } else {
      changes.push({ from: line.from, to: line.from, insert: prefix });
      if (lineNumber === startLine.number) selectionDelta = prefix.length;
    }
  }

  view.dispatch({
    changes,
    selection: { anchor: Math.max(startLine.from, from + selectionDelta) },
  });
  view.focus();
}

export function toggleBulletList(view: EditorView): void {
  toggleLinePrefix(view, '- ', (text) => text.match(BULLET_RE));
}

export function toggleOrderedList(view: EditorView): void {
  toggleLinePrefix(view, '1. ', (text) => text.match(ORDERED_RE));
}

export function toggleTaskList(view: EditorView): void {
  toggleLinePrefix(view, '- [ ] ', (text) => text.match(TASK_RE));
}

export function cycleHeading(view: EditorView): void {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const headingMatch = line.text.match(HEADING_RE);

  if (headingMatch) {
    const level = headingMatch[1].length;
    if (level < 3) {
      const prefix = `${'#'.repeat(level + 1)} `;
      view.dispatch({
        changes: { from: line.from, to: line.from + headingMatch[0].length, insert: prefix },
        selection: { anchor: from + prefix.length - headingMatch[0].length },
      });
    } else {
      view.dispatch({
        changes: { from: line.from, to: line.from + headingMatch[0].length, insert: '' },
        selection: { anchor: Math.max(line.from, from - headingMatch[0].length) },
      });
    }
    view.focus();
    return;
  }

  const existingPrefix = ALL_LINE_PREFIXES.map((pattern) => line.text.match(pattern)).find(Boolean);
  if (existingPrefix) {
    view.dispatch({
      changes: { from: line.from, to: line.from + existingPrefix[0].length, insert: '# ' },
      selection: { anchor: Math.max(line.from, from + 2 - existingPrefix[0].length) },
    });
  } else {
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: '# ' },
      selection: { anchor: from + 2 },
    });
  }
  view.focus();
}

export function toggleBlockquote(view: EditorView): void {
  toggleLinePrefix(view, '> ', (text) => text.match(QUOTE_RE));
}
