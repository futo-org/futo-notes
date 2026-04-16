import { keymap, EditorView } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

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
  const quoteMatch = text.match(/^((?:>\s*)+)(.*)/);
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

  return false;
}

// Prec.highest so this runs before @codemirror/lang-markdown's
// built-in insertNewlineContinueMarkup (which is Prec.high)
export const listContinuationKeymap = Prec.highest(keymap.of([
  { key: 'Enter', run: handleEnter }
]));
