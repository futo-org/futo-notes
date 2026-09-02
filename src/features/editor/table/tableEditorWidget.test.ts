// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { TableEditorWidget } from './tableEditorWidget';

const TABLE = '| A | B |\n| --- | --- |\n| x | y |\n| z | w |';
const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function createView(): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({ state: EditorState.create({ doc: TABLE }), parent });
  views.push(view);
  return view;
}

function cellTexts(dom: HTMLElement): string[] {
  return Array.from(
    dom.querySelectorAll<HTMLElement>('.sf-table__cell'),
    (cell) => cell.textContent ?? '',
  );
}

describe('TableEditorWidget DOM lifecycle', () => {
  // github#41: CodeMirror drops a block widget's DOM once it scrolls out of the
  // rendered viewport and asks the SAME widget instance for a new one when it
  // scrolls back. The second toDOM used to compare the parsed shape against the
  // cell elements cached from the first DOM, conclude nothing structural had
  // changed, and hand back an empty <table> — the note showed a blank band where
  // the table (and its source text) should be.
  it('renders a complete table every time toDOM is called on the same instance', () => {
    const view = createView();
    const widget = new TableEditorWidget(TABLE, 0, TABLE.length);

    const first = widget.toDOM(view);
    expect(cellTexts(first)).toEqual(['A', 'B', 'x', 'y', 'z', 'w']);

    const second = widget.toDOM(view);
    expect(second).not.toBe(first);
    expect(cellTexts(second)).toEqual(['A', 'B', 'x', 'y', 'z', 'w']);
    expect(second.querySelector('.sf-table__row-controls')).not.toBeNull();
    expect(second.querySelector('.sf-table__col-controls')).not.toBeNull();
  });

  it('adopts a foreign DOM in updateDOM without leaving stale cells behind', () => {
    const view = createView();
    const original = new TableEditorWidget(TABLE, 0, TABLE.length);
    const dom = original.toDOM(view);

    const replacement = new TableEditorWidget(TABLE, 0, TABLE.length);
    expect(replacement.updateDOM(dom, view)).toBe(true);
    expect(cellTexts(dom)).toEqual(['A', 'B', 'x', 'y', 'z', 'w']);
  });
});
