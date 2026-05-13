import { keymap, EditorView, ViewPlugin } from '@codemirror/view';
import { Annotation, EditorSelection, Prec } from '@codemirror/state';
import type { ChangeSpec, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

const QUOTE_RE = /^((?:>\s*)+)(.*)$/;

function handleEnter(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.from;

  // Inside a fenced/indented code block, provide an escape hatch:
  // if the current line is empty AND the next line is the closing fence,
  // move the cursor past the fence instead of inserting another \n.
  for (let node = syntaxTree(state).resolve(pos); ; ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      const currentLine = state.doc.lineAt(pos);
      const isEmpty = currentLine.text.trim() === '';
      if (isEmpty && currentLine.number < state.doc.lines) {
        const nextLine = state.doc.line(currentLine.number + 1);
        if (/^\s*`{3,}\s*$/.test(nextLine.text)) {
          // Move past the closing fence, collapse the empty line we're on.
          view.dispatch({
            changes: { from: currentLine.from, to: nextLine.to, insert: nextLine.text },
            selection: EditorSelection.cursor(currentLine.from + nextLine.text.length),
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

  // Task list: - [ ] or - [x]
  const taskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)/);
  if (taskMatch) {
    const [, indent, bullet, , content] = taskMatch;
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from)
      });
      return true;
    }
    view.dispatch(state.replaceSelection(`\n${indent}${bullet} [ ] `));
    return true;
  }

  // Ordered list
  const orderedMatch = text.match(/^(\s*)(\d+)\.\s+(.*)/);
  if (orderedMatch) {
    const [, indent, num, content] = orderedMatch;
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from)
      });
      return true;
    }
    view.dispatch(state.replaceSelection(`\n${indent}${parseInt(num) + 1}. `));
    return true;
  }

  // Unordered list
  const bulletMatch = text.match(/^(\s*)([-*+])\s+(.*)/);
  if (bulletMatch) {
    const [, indent, bullet, content] = bulletMatch;
    if (!content.trim()) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from)
      });
      return true;
    }
    view.dispatch(state.replaceSelection(`\n${indent}${bullet} `));
    return true;
  }

  // Blockquote continuation
  const quoteMatch = text.match(QUOTE_RE);
  if (quoteMatch) {
    const [, markers, content] = quoteMatch;
    const level = (markers.match(/>/g) || []).length;

    // If content after markers is a list item, let the built-in
    // markdown handler deal with it (it handles nested list+quote)
    if (content.match(/^\s*[-*+]\s/) || content.match(/^\s*\d+\.\s/)) {
      return false;
    }

    if (!content.trim()) {
      if (level > 1) {
        // Nested quote — step down one level
        const newMarkers = '> '.repeat(level - 1);
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: newMarkers },
          selection: EditorSelection.cursor(line.from + newMarkers.length)
        });
      } else {
        // Level 1 — exit blockquote entirely. Insert a leading newline so a blank
        // line sits between the last `>` line and the cursor's paragraph — this
        // stops the markdown parser from lazy-continuing the blockquote (which
        // was causing typed text to re-appear as `> text` via insertNewlineContinueMarkup).
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: '\n' },
          selection: EditorSelection.cursor(line.from + 1)
        });
      }
      return true;
    }
    // Continue blockquote — normalize to `> ` per level for consistent spacing
    const normalizedMarkers = '> '.repeat(level);
    view.dispatch(state.replaceSelection(`\n${normalizedMarkers}`));
    return true;
  }

  // Prose line with leading whitespace. The CM6 default insertNewline
  // propagates the previous line's indent verbatim, which means a stray
  // leading space carries onto every new line. Strip spaces and keep only
  // tabs (intentional outline indent) on the new line.
  const leadMatch = text.match(/^[ \t]+/);
  if (leadMatch) {
    const tabsOnly = leadMatch[0].replace(/ /g, '');
    view.dispatch(state.replaceSelection(`\n${tabsOnly}`));
    return true;
  }

  return false;
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
      insert: nextMarkers
    });
  }

  if (changes.length === 0) return false;

  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: state.selection.map(changeSet)
  });
  return true;
}

// Tab/Shift-Tab go through the normal keymap — those don't have iOS issues.
// Prec.highest so they run before @codemirror/lang-markdown's defaults.
const tabKeymap = Prec.highest(keymap.of([
  { key: 'Tab', run: (view) => changeQuoteDepth(view, 1) },
  { key: 'Shift-Tab', run: (view) => changeQuoteDepth(view, -1) }
]));

// Enter is handled at document-capture phase, NOT via the CM6 keymap. iOS's
// WKWebView intercepts Enter on certain cursor positions (e.g., when the
// cursor sits right after a contenteditable=false widget like a rendered
// list marker) and applies its own native newline insertion without ever
// firing `beforeinput`. CM6's keymap only runs when CM6 sees beforeinput
// and synthesizes a keydown; since beforeinput never arrives in that case,
// the keymap silently doesn't fire and the empty list marker survives.
//
// By listening at document capture phase we get the keydown before iOS
// applies its default, run handleEnter directly, and preventDefault to
// stop the native insertion when we handle the event ourselves.
const enterCaptureHandler = ViewPlugin.fromClass(class {
  listener: (e: KeyboardEvent) => void;
  constructor(view: EditorView) {
    this.listener = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (!view.contentDOM.contains(e.target as Node)) return;
      if (handleEnter(view)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', this.listener as EventListener, true);
  }
  destroy() {
    document.removeEventListener('keydown', this.listener as EventListener, true);
  }
});

export const listContinuationKeymap = [tabKeymap, enterCaptureHandler];

const ORDERED_LINE_RE = /^(\s*)(\d+)\.\s/;

function findOrderedBlockStart(doc: Text, lineNumber: number, indent: string): number {
  let start = lineNumber;
  while (start > 1) {
    const prev = doc.line(start - 1).text.match(ORDERED_LINE_RE);
    if (!prev || prev[1] !== indent) break;
    start -= 1;
  }
  return start;
}

export function computeOrderedRenumberChanges(
  doc: Text,
  affectedLines: Iterable<number>
): ChangeSpec[] {
  const blockStarts = new Set<number>();
  for (const ln of affectedLines) {
    if (ln < 1 || ln > doc.lines) continue;
    let probe = ln;
    let m = doc.line(probe).text.match(ORDERED_LINE_RE);
    if (!m && probe > 1) {
      // Line itself isn't an ordered item (e.g. it was just deleted into) —
      // probe the previous line so a list above the deletion still gets fixed.
      probe -= 1;
      m = doc.line(probe).text.match(ORDERED_LINE_RE);
    }
    if (!m) continue;
    blockStarts.add(findOrderedBlockStart(doc, probe, m[1]));
  }

  const changes: ChangeSpec[] = [];
  for (const startLn of blockStarts) {
    const startLine = doc.line(startLn);
    const startMatch = startLine.text.match(ORDERED_LINE_RE);
    if (!startMatch) continue;
    const indent = startMatch[1];
    const startNum = parseInt(startMatch[2], 10);

    let offset = 0;
    let lineNum = startLn;
    while (lineNum <= doc.lines) {
      const line = doc.line(lineNum);
      const m = line.text.match(ORDERED_LINE_RE);
      if (!m || m[1] !== indent) break;
      const expected = String(startNum + offset);
      if (m[2] !== expected) {
        const numStart = line.from + indent.length;
        changes.push({ from: numStart, to: numStart + m[2].length, insert: expected });
      }
      offset += 1;
      lineNum += 1;
    }
  }
  return changes;
}

const renumberAnnotation = Annotation.define<true>();

// Auto-renumber contiguous ordered-list blocks after edits. Implemented as an
// update listener so we can dispatch a follow-up transaction with the
// renumber changes — `transactionExtender` only accepts effects/annotations,
// not changes.
export const orderedListRenumber = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  // Skip our own auto-renumber dispatches to avoid loops.
  if (update.transactions.some((t) => t.annotation(renumberAnnotation))) return;

  const affected = new Set<number>();
  const newDoc = update.state.doc;
  for (const tr of update.transactions) {
    tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      const startLn = newDoc.lineAt(fromB).number;
      const endLn = newDoc.lineAt(toB).number;
      for (let i = startLn; i <= endLn; i++) affected.add(i);
      // Peek the line above — a backspace at the start of a list line joins
      // it onto the previous, and the merged block also wants fixing.
      if (startLn > 1) affected.add(startLn - 1);
    });
  }

  const changes = computeOrderedRenumberChanges(newDoc, affected);
  if (changes.length === 0) return;
  update.view.dispatch({
    changes,
    annotations: renumberAnnotation.of(true),
    // Don't push the renumber onto the undo stack on its own — make undo of
    // the user's edit also undo the renumber by joining them.
    userEvent: 'input.renumber'
  });
});
