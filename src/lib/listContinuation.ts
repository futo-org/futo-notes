import { keymap } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';

function handleEnter(view: any): boolean {
  const { state } = view;
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

  return false;
}

export const listContinuationKeymap = keymap.of([
  { key: 'Enter', run: handleEnter }
]);
