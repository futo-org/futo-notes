import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type LineKind =
  | { kind: 'none' }
  | { kind: 'bullet' }
  | { kind: 'ordered'; n: number }
  | { kind: 'task'; checked: boolean }
  | { kind: 'heading'; level: number }
  | { kind: 'quote' };

export interface ParsedLine {
  indent: string;
  lineKind: LineKind;
  content: string;
}

type BlockCommand = 'bullet' | 'ordered' | 'task' | 'heading' | 'quote';

const INDENT_RE = /^[\t ]*/;
const TASK_RE = /^- \[([ xX])\] /;
const BULLET_RE = /^- /;
const ORDERED_RE = /^(\d+)\. /;
const HEADING_RE = /^(#{1,3}) /;
const QUOTE_RE = /^> /;

export function parseLine(text: string): ParsedLine {
  const indent = text.match(INDENT_RE)?.[0] ?? '';
  const remainder = text.slice(indent.length);

  const task = remainder.match(TASK_RE);
  if (task) {
    return {
      indent,
      lineKind: { kind: 'task', checked: task[1] !== ' ' },
      content: remainder.slice(task[0].length),
    };
  }

  const bullet = remainder.match(BULLET_RE);
  if (bullet) {
    return {
      indent,
      lineKind: { kind: 'bullet' },
      content: remainder.slice(bullet[0].length),
    };
  }

  const ordered = remainder.match(ORDERED_RE);
  if (ordered) {
    return {
      indent,
      lineKind: { kind: 'ordered', n: Number.parseInt(ordered[1], 10) },
      content: remainder.slice(ordered[0].length),
    };
  }

  const heading = remainder.match(HEADING_RE);
  if (heading) {
    return {
      indent,
      lineKind: { kind: 'heading', level: heading[1].length },
      content: remainder.slice(heading[0].length),
    };
  }

  const quote = remainder.match(QUOTE_RE);
  if (quote) {
    return {
      indent,
      lineKind: { kind: 'quote' },
      content: remainder.slice(quote[0].length),
    };
  }

  return { indent, lineKind: { kind: 'none' }, content: remainder };
}

function serializeLineKind(lineKind: LineKind): string {
  let prefix: string;

  switch (lineKind.kind) {
    case 'none':
      prefix = '';
      break;
    case 'bullet':
      prefix = '- ';
      break;
    case 'ordered':
      prefix = `${lineKind.n}. `;
      break;
    case 'task':
      prefix = lineKind.checked ? '- [x] ' : '- [ ] ';
      break;
    case 'heading':
      prefix = `${'#'.repeat(lineKind.level)} `;
      break;
    case 'quote':
      prefix = '> ';
      break;
  }

  return prefix;
}

export function serializeLine({ indent, lineKind, content }: ParsedLine): string {
  return `${indent}${serializeLineKind(lineKind)}${content}`;
}

export function isListLine(text: string): boolean {
  const kind = parseLine(text).lineKind.kind;
  return kind === 'bullet' || kind === 'ordered' || kind === 'task';
}

function transitionLineKind(current: LineKind, command: BlockCommand): LineKind {
  switch (command) {
    case 'bullet':
      return current.kind === 'bullet' ? { kind: 'none' } : { kind: 'bullet' };
    case 'ordered':
      return current.kind === 'ordered' ? { kind: 'none' } : { kind: 'ordered', n: 1 };
    case 'task':
      return current.kind === 'task' ? { kind: 'none' } : { kind: 'task', checked: false };
    case 'heading':
      if (current.kind !== 'heading') return { kind: 'heading', level: 1 };
      return current.level < 3 ? { kind: 'heading', level: current.level + 1 } : { kind: 'none' };
    case 'quote':
      return current.kind === 'quote' ? { kind: 'none' } : { kind: 'quote' };
  }
}

function prefixLength(parsed: ParsedLine): number {
  return serializeLineKind(parsed.lineKind).length;
}

/**
 * Whether `pos` sits inside a fenced or indented code block.
 *
 * Read off the markdown syntax tree rather than by scanning for fence markers,
 * because the parser already knows where a fence opens and closes — the same
 * ancestor walk `listContinuation.ts`'s Enter handler does. A tree that has not
 * been parsed that far cannot say, and reports no code block; the caret is in
 * the viewport, which is what CodeMirror parses first.
 */
function isInCodeBlock(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  if (pos > tree.length) return false;
  for (let node = tree.resolveInner(pos, 1); node.parent; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
  }
  return false;
}

function applyBlockCommand(view: EditorView, command: BlockCommand): void {
  const { state } = view;
  const { from, to } = state.selection.main;
  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);
  const changes: { from: number; to: number; insert: string }[] = [];
  let selectionDelta = 0;

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber++) {
    const line = state.doc.line(lineNumber);
    const parsed = parseLine(line.text);
    // A code block's content is LITERAL TEXT: a `>` or `#` written onto one of
    // its lines is code, not a block prefix, so the line is left exactly as it
    // is — fence markers included. A selection that spans a fence still formats
    // the prose around it. The Milkdown engine gives the same answer by having
    // no transition for its `code` kind (milkdown/blockCommands.ts), and
    // docs/spec/editor.md -> "Markdown toolbar" states the rule once.
    //
    // Asked at the line's CONTENT, not at `line.from`: an indented code block
    // starts where its text does, so a position in the indentation is still
    // outside the node.
    if (isInCodeBlock(state, line.from + parsed.indent.length)) continue;
    const rewritten = { ...parsed, lineKind: transitionLineKind(parsed.lineKind, command) };
    const nextText = serializeLine(rewritten);

    changes.push({ from: line.from, to: line.to, insert: nextText });
    if (lineNumber === startLine.number) {
      selectionDelta = prefixLength(rewritten) - prefixLength(parsed);
    }
  }

  if (changes.length === 0) {
    // Every selected line was inside a code block: leave the note, and the
    // selection, exactly as they are.
    view.focus();
    return;
  }

  view.dispatch({
    changes,
    selection: { anchor: Math.max(startLine.from, from + selectionDelta) },
  });
  view.focus();
}

export function toggleBulletList(view: EditorView): void {
  applyBlockCommand(view, 'bullet');
}

export function toggleOrderedList(view: EditorView): void {
  applyBlockCommand(view, 'ordered');
}

export function toggleTaskList(view: EditorView): void {
  applyBlockCommand(view, 'task');
}

export function cycleHeading(view: EditorView): void {
  applyBlockCommand(view, 'heading');
}

export function toggleBlockquote(view: EditorView): void {
  applyBlockCommand(view, 'quote');
}
