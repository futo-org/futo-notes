import { keymap, EditorView } from '@codemirror/view';
import { EditorSelection, Prec } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

function handleEnter(view: EditorView): boolean {
  const { state } = view;
  const pos = state.selection.main.from;

  // Let default enter behavior handle markdown inside code fences/blocks.
  for (let node = syntaxTree(state).resolve(pos); ; ) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
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
        changes: { from: line.from, to: line.to, insert: indent },
        selection: EditorSelection.cursor(line.from + indent.length)
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
        changes: { from: line.from, to: line.to, insert: indent },
        selection: EditorSelection.cursor(line.from + indent.length)
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
        changes: { from: line.from, to: line.to, insert: indent },
        selection: EditorSelection.cursor(line.from + indent.length)
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
        // Level 1 — exit blockquote entirely
        view.dispatch({
          changes: { from: line.from, to: line.to, insert: '' },
          selection: EditorSelection.cursor(line.from)
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
