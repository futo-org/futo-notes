// @vitest-environment jsdom
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, StateEffect, type StateField } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';

import { createMarkdownLanguageSupport } from './codeMirrorMarkdown';
import { interactiveTableEditor } from './table/interactiveTableEditor';
import { TableEditorWidget } from './table/tableEditorWidget';
import { swapEditorState } from './swapEditorState';

const TABLE = '| A | B |\n| --- | --- |\n| x | y |';
const INTRO = 'intro paragraph\n\n';
const CARET_IN_TABLE = `${INTRO}${TABLE}`.indexOf('x');

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
});

/** A note's state as `openNote` builds it: fully parsed, with a restored caret. */
function parsedNoteState(doc: string, cursor: number): EditorState {
  const parsing = EditorState.create({ doc, extensions: [createMarkdownLanguageSupport()] });
  const tree = ensureSyntaxTree(parsing, parsing.doc.length, 5_000);
  if (!tree || tree.length < parsing.doc.length) {
    throw new Error(
      `test setup did not finish parsing the document (${tree?.length ?? 0}/${parsing.doc.length})`,
    );
  }
  return parsing.update({
    effects: StateEffect.appendConfig.of(interactiveTableEditor),
    selection: EditorSelection.cursor(cursor),
  }).state;
}

function mountView(state: EditorState): EditorView {
  const view = new EditorView({ state, parent: document.body });
  views.push(view);
  return view;
}

function focusedView(state: EditorState): EditorView {
  const view = mountView(state);
  view.focus();
  if (!view.hasFocus) throw new Error('test setup could not focus the editor');
  return view;
}

const tableEditorField = interactiveTableEditor[0] as StateField<{ decorations: DecorationSet }>;

function tableWidgetCount(view: EditorView): number {
  let count = 0;
  const cursor = view.state.field(tableEditorField).decorations.iter();
  while (cursor.value) {
    if (cursor.value.spec.widget instanceof TableEditorWidget) count += 1;
    cursor.next();
  }
  return count;
}

describe('swapEditorState', () => {
  it('leaves the table under the restored caret in source form when the editor is focused', () => {
    const view = focusedView(parsedNoteState('a different note', 0));

    swapEditorState(view, parsedNoteState(`${INTRO}${TABLE}`, CARET_IN_TABLE));

    expect(view.hasFocus).toBe(true);
    expect(tableWidgetCount(view)).toBe(0);
  });

  it('leaves the table in source form when the caret lands there after the parse catches up', () => {
    const view = focusedView(parsedNoteState('a different note', 0));
    const doc = `${INTRO}${TABLE}`;

    // The real open path installs an unparsed state: the field finds no table until the
    // parse reaches it, and reads its (stale) focus flag at that later moment.
    swapEditorState(
      view,
      EditorState.create({
        doc,
        selection: EditorSelection.cursor(CARET_IN_TABLE),
        extensions: [createMarkdownLanguageSupport(), interactiveTableEditor],
      }),
    );
    ensureSyntaxTree(view.state, doc.length, 5_000);
    view.dispatch({});

    expect(tableWidgetCount(view)).toBe(0);
  });

  it('keeps the table widget when the editor is not focused', () => {
    const view = mountView(parsedNoteState('a different note', 0));
    expect(view.hasFocus).toBe(false);

    swapEditorState(view, parsedNoteState(`${INTRO}${TABLE}`, CARET_IN_TABLE));

    expect(tableWidgetCount(view)).toBe(1);
  });
});
