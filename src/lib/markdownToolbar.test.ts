// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { toggleBold, toggleItalic, toggleStrikethrough } from './markdownToolbar';

const views: EditorView[] = [];

afterEach(() => {
  for (const v of views) v.destroy();
  views.length = 0;
});

function setup(doc: string, selection: { anchor: number; head?: number }): EditorView {
  const view = new EditorView({
    doc,
    selection,
    extensions: [markdown()],
    parent: document.body,
  });
  views.push(view);
  return view;
}

function selection(view: EditorView): { from: number; to: number } {
  const range = view.state.selection.main;
  return { from: range.from, to: range.to };
}

describe('markdown toolbar inline toggles', () => {
  it('unwraps italic when the selected rendered word includes hidden markers', () => {
    const view = setup('*word*', { anchor: 0, head: 6 });

    toggleItalic(view);

    expect(view.state.doc.toString()).toBe('word');
    expect(selection(view)).toEqual({ from: 0, to: 4 });
  });

  it('unwraps italic when only the inner text is selected', () => {
    const view = setup('*word*', { anchor: 1, head: 5 });

    toggleItalic(view);

    expect(view.state.doc.toString()).toBe('word');
    expect(selection(view)).toEqual({ from: 0, to: 4 });
  });

  it('does not treat strong markers as italic markers', () => {
    const view = setup('**word**', { anchor: 2, head: 6 });

    toggleItalic(view);

    expect(view.state.doc.toString()).toBe('***word***');
    expect(selection(view)).toEqual({ from: 3, to: 7 });
  });

  it('unwraps bold when the selection includes markers', () => {
    const view = setup('**word**', { anchor: 0, head: 8 });

    toggleBold(view);

    expect(view.state.doc.toString()).toBe('word');
    expect(selection(view)).toEqual({ from: 0, to: 4 });
  });

  it('unwraps strikethrough when the selection includes markers', () => {
    const view = setup('~~word~~', { anchor: 0, head: 8 });

    toggleStrikethrough(view);

    expect(view.state.doc.toString()).toBe('word');
    expect(selection(view)).toEqual({ from: 0, to: 4 });
  });
});
