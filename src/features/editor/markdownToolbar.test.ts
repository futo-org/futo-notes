// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { TOOLBAR_EXEC_IDS } from '@futo-notes/editor';
import {
  TOOLBAR_EXEC,
  cycleHeading,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
} from './markdownToolbar';

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

describe('cycleHeading selection safety', () => {
  it('clamps the cursor to line start when removing a heading from inside the prefix', () => {
    const view = setup('### Hello', { anchor: 2 });

    cycleHeading(view);

    expect(view.state.doc.toString()).toBe('Hello');
    expect(selection(view).from).toBe(0);

    cycleHeading(view);
    expect(view.state.doc.toString()).toBe('# Hello');
  });

  it('clamps the cursor when converting another prefix from inside that prefix', () => {
    const view = setup('12. Hello', { anchor: 1 });

    cycleHeading(view);

    expect(view.state.doc.toString()).toBe('# Hello');
    expect(selection(view).from).toBe(0);

    cycleHeading(view);
    expect(view.state.doc.toString()).toBe('## Hello');
  });

  it('clamps on a non-first line so the cursor cannot escape into the previous line', () => {
    const doc = 'intro\n### Hello';
    const view = setup(doc, { anchor: doc.indexOf('### ') + 2 });

    cycleHeading(view);

    expect(view.state.doc.toString()).toBe('intro\nHello');
    expect(selection(view).from).toBe('intro\n'.length);
  });
});

describe('TOOLBAR_EXEC registry', () => {
  it('implements exactly the exec ids in the toolbar manifest', () => {
    expect(Object.keys(TOOLBAR_EXEC).sort()).toEqual([...TOOLBAR_EXEC_IDS].sort());
  });

  it('exec entries mutate the document like the underlying command', () => {
    const view = setup('word', { anchor: 0, head: 4 });

    TOOLBAR_EXEC['bold'](view);

    expect(view.state.doc.toString()).toBe('**word**');
  });

  it('indent/outdent entries indent and dedent a list line', () => {
    const view = setup('- item', { anchor: 3 });

    TOOLBAR_EXEC['indent'](view);
    expect(view.state.doc.toString()).toBe('  - item');

    TOOLBAR_EXEC['outdent'](view);
    expect(view.state.doc.toString()).toBe('- item');
  });

  it('link wraps a selection into a scaffold WITHOUT prompting (native WebViews have no window.prompt)', () => {
    const view = setup('futo', { anchor: 0, head: 4 });

    TOOLBAR_EXEC['link'](view);

    expect(view.state.doc.toString()).toBe('[futo]()');
    const sel = view.state.selection.main;
    expect(sel.empty).toBe(true);
    expect(sel.head).toBe('[futo]('.length); // caret between ( and )
  });

  it('link inserts an empty scaffold with the caret between the brackets when there is no selection', () => {
    const view = setup('', { anchor: 0 });

    TOOLBAR_EXEC['link'](view);

    expect(view.state.doc.toString()).toBe('[]()');
    expect(view.state.selection.main.head).toBe(1); // [|]()
  });
});
