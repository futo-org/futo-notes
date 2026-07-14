import { keymap, EditorView, ViewPlugin } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
import type { ChangeSpec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

export { computeOrderedRenumberChanges, orderedListRenumber } from './orderedListRenumber';

const QUOTE_RE = /^((?:>\s*)+)(.*)$/;

function handleEnter(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.from;

  for (let node = syntaxTree(state).resolve(pos); ;) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      const currentLine = state.doc.lineAt(pos);
      const isEmpty = currentLine.text.trim() === '';
      if (isEmpty && currentLine.number < state.doc.lines) {
        const nextLine = state.doc.line(currentLine.number + 1);
        if (/^\s*`{3,}\s*$/.test(nextLine.text)) {
          view.dispatch({
            changes: { from: currentLine.from, to: nextLine.to, insert: nextLine.text },
            selection: EditorSelection.cursor(currentLine.from + nextLine.text.length),
            scrollIntoView: true,
          });
          return true;
        }
      }
      return false;
    }
    if (!node.parent) break;
    node = node.parent;
  }

  const line = state.doc.lineAt(state.selection.main.from);
  const text = line.text;

  const taskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)/);
  if (taskMatch) {
    const [, indent, bullet, , content] = taskMatch;
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({ ...state.replaceSelection(`\n${indent}${bullet} [ ] `), scrollIntoView: true });
    return true;
  }

  const orderedMatch = text.match(/^(\s*)(\d+)\.\s+(.*)/);
  if (orderedMatch) {
    const [, indent, num, content] = orderedMatch;
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({
      ...state.replaceSelection(`\n${indent}${parseInt(num) + 1}. `),
      scrollIntoView: true,
    });
    return true;
  }

  const bulletMatch = text.match(/^(\s*)([-*+])\s+(.*)/);
  if (bulletMatch) {
    const [, indent, bullet, content] = bulletMatch;
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
        scrollIntoView: true,
      });
      return true;
    }
    view.dispatch({ ...state.replaceSelection(`\n${indent}${bullet} `), scrollIntoView: true });
    return true;
  }

  const quoteMatch = text.match(QUOTE_RE);
  if (quoteMatch) {
    const [, markers, content] = quoteMatch;
    const level = (markers.match(/>/g) || []).length;

    if (content.match(/^\s*[-*+]\s/) || content.match(/^\s*\d+\.\s/)) {
      return false;
    }

    if (!content.trim()) {
      if (level > 1) {
        const newMarkers = '> '.repeat(level - 1);
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newMarkers },
          selection: EditorSelection.cursor(line.from + newMarkers.length),
          scrollIntoView: true,
        });
      } else {
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: '\n' },
          selection: EditorSelection.cursor(line.from + 1),
          scrollIntoView: true,
        });
      }
      return true;
    }
    const normalizedMarkers = '> '.repeat(level);
    view.dispatch({ ...state.replaceSelection(`\n${normalizedMarkers}`), scrollIntoView: true });
    return true;
  }

  const leadMatch = text.match(/^[ \t]+/);
  if (leadMatch) {
    const tabsOnly = leadMatch[0].replace(/ /g, '');
    view.dispatch({ ...state.replaceSelection(`\n${tabsOnly}`), scrollIntoView: true });
    return true;
  }

  return false;
}

function dedentOne(indent: string): string {
  if (indent.endsWith('\t')) return indent.slice(0, -1);
  if (indent.endsWith('  ')) return indent.slice(0, -2);
  if (indent.length > 0) return indent.slice(0, -1);
  return indent;
}

function handleBackspace(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false; // backspace over a selection is a plain delete

  const pos = range.from;
  const line = state.doc.lineAt(pos);
  const text = line.text;

  const m =
    text.match(/^(\s*)([-*+])\s+\[[ xX]\]\s?/) ??
    text.match(/^(\s*)(\d+)\.\s+/) ??
    text.match(/^(\s*)([-*+])\s+/);
  if (!m) return false;

  const prefixLen = m[0].length;
  const indent = m[1];
  const contentStart = line.from + prefixLen;
  const content = text.slice(prefixLen);

  if (content.trim() === '') {
    if (pos < contentStart) return false; // caret sits within the marker — leave it
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: EditorSelection.cursor(line.from),
      scrollIntoView: true,
    });
    return true;
  }

  if (pos !== contentStart) return false;

  if (indent.length > 0) {
    const newIndent = dedentOne(indent);
    const removed = indent.length - newIndent.length;
    if (removed === 0) return false;
    view.dispatch({
      changes: { from: line.from, to: line.from + indent.length, insert: newIndent },
      selection: EditorSelection.cursor(contentStart - removed),
      scrollIntoView: true,
    });
    return true;
  }

  view.dispatch({
    changes: { from: line.from, to: contentStart, insert: '' },
    selection: EditorSelection.cursor(line.from),
    scrollIntoView: true,
  });
  return true;
}

function getSelectedLineNumbers(view: EditorView): number[] {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const fromLine = view.state.doc.lineAt(range.from).number;
    const toPos = range.empty ? range.to : Math.max(range.from, range.to - 1);
    const toLine = view.state.doc.lineAt(toPos).number;
    for (let line = fromLine; line <= toLine; line += 1) {
      lines.add(line);
    }
  }
  return [...lines].sort((a, b) => a - b);
}

function changeQuoteDepth(view: EditorView, delta: 1 | -1): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];

  for (const lineNumber of getSelectedLineNumbers(view)) {
    const line = state.doc.line(lineNumber);
    const match = line.text.match(QUOTE_RE);
    if (!match) continue;

    const markers = match[1];
    const level = markers.match(/>/g)?.length ?? 0;
    if (level === 0) continue;

    const nextLevel = level + delta;
    const nextMarkers = nextLevel > 0 ? '> '.repeat(nextLevel) : '';
    changes.push({
      from: line.from,
      to: line.from + markers.length,
      insert: nextMarkers,
    });
  }

  if (changes.length === 0) return false;

  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet),
  });
  return true;
}

const tabKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: (view) => changeQuoteDepth(view, 1) },
    { key: 'Shift-Tab', run: (view) => changeQuoteDepth(view, -1) },
  ]),
);

// iOS WKWebView can apply Enter/Backspace beside non-editable marker widgets
// without delivering the `beforeinput` event CM6's keymap relies on. Capture
// keydown at the document boundary so handled list edits can prevent the
// native edit before it diverges from CodeMirror state.
const listEditCaptureHandler = ViewPlugin.fromClass(
  class {
    listener: (e: KeyboardEvent) => void;
    constructor(view: EditorView) {
      this.listener = (e: KeyboardEvent) => {
        if (e.isComposing) return;
        if (!view.contentDOM.contains(e.target as Node)) return;
        let handled = false;
        if (e.key === 'Enter') handled = handleEnter(view);
        else if (e.key === 'Backspace') handled = handleBackspace(view);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      document.addEventListener('keydown', this.listener as EventListener, true);
    }
    destroy() {
      document.removeEventListener('keydown', this.listener as EventListener, true);
    }
  },
);

export const listContinuationKeymap = [tabKeymap, listEditCaptureHandler];
