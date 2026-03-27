import { EditorSelection, Prec } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';

function moveAcrossEmptyLine(view: EditorView, direction: 'up' | 'down'): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;

  const line = state.doc.lineAt(range.head);
  if (line.text.length !== 0 || range.head !== line.from) return false;

  if (direction === 'up') {
    if (line.number <= 1) return false;
    const prevLine = state.doc.line(line.number - 1);
    view.dispatch({ selection: EditorSelection.cursor(prevLine.from) });
    return true;
  }

  if (line.number >= state.doc.lines) return false;
  const nextLine = state.doc.line(line.number + 1);
  view.dispatch({ selection: EditorSelection.cursor(nextLine.from) });
  return true;
}

export const cursorMotionKeymap = Prec.highest(keymap.of([
  { key: 'ArrowUp', run: (view) => moveAcrossEmptyLine(view, 'up') },
  { key: 'ArrowDown', run: (view) => moveAcrossEmptyLine(view, 'down') },
]));
