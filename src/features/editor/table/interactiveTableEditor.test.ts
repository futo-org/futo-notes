// @vitest-environment jsdom
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, StateEffect, type StateField } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMarkdownLanguageSupport } from '../codeMirrorMarkdown';
import { interactiveTableEditor, tableFocusSyncEffect } from './interactiveTableEditor';
import { TableEditorWidget } from './tableEditorWidget';

const { actualSyntaxTree, iterateCalls, syntaxTreeMock } = vi.hoisted(() => ({
  actualSyntaxTree: {
    current: null as null | (typeof import('@codemirror/language'))['syntaxTree'],
  },
  iterateCalls: [] as Array<{ from?: number; to?: number }>,
  syntaxTreeMock: vi.fn(),
}));

vi.mock('@codemirror/language', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@codemirror/language')>();
  actualSyntaxTree.current = actual.syntaxTree;
  return {
    ...actual,
    syntaxTree: syntaxTreeMock,
  };
});

interface TableEditorFieldValue {
  decorations: DecorationSet;
  tables: readonly { from: number; to: number }[];
  hasFocus: boolean;
}

interface TableDecoration {
  from: number;
  to: number;
  widget: TableEditorWidget;
}

const TABLE = '| A | B |\n| --- | --- |\n| x | y |';
const views: EditorView[] = [];
const tableEditorField = interactiveTableEditor[0] as StateField<TableEditorFieldValue>;

beforeEach(() => {
  iterateCalls.length = 0;
  syntaxTreeMock.mockImplementation((state: EditorState) => {
    const tree = actualSyntaxTree.current!(state);
    return new Proxy(tree, {
      get(target, property) {
        if (property === 'iterate') {
          return (spec: { from?: number; to?: number }) => {
            iterateCalls.push({ from: spec.from, to: spec.to });
            return target.iterate(spec);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
});

afterEach(() => {
  for (const view of views) view.destroy();
  views.length = 0;
  vi.restoreAllMocks();
});

function setupState(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [createMarkdownLanguageSupport()],
  });
  const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
  if (!tree || tree.length < state.doc.length) {
    throw new Error(
      `test setup did not finish parsing the document (${tree?.length ?? 0}/${state.doc.length})`,
    );
  }
  return state.update({ effects: StateEffect.appendConfig.of(interactiveTableEditor) }).state;
}

function setupEditor(doc: string): EditorView {
  const view = new EditorView({ state: setupState(doc), parent: document.body });
  views.push(view);
  return view;
}

const RENUMBER_LINE_COUNT = 400;
const READ_BOUND = RENUMBER_LINE_COUNT * 8;

function setupOrderedListEditor(): EditorView {
  return setupEditor(
    Array.from({ length: RENUMBER_LINE_COUNT }, (_, index) => `${index + 1}. item ${index}`).join(
      '\n',
    ),
  );
}

function spyOnLineReads(view: EditorView) {
  return vi.spyOn(Object.getPrototypeOf(view.state.doc), 'line');
}

/** Report a syntax tree that stops short of the document, as a busy machine does. */
function pinTreeLength(length: number): void {
  syntaxTreeMock.mockImplementation((state: EditorState) => {
    const tree = actualSyntaxTree.current!(state);
    return new Proxy(tree, {
      get(target, property) {
        if (property === 'length') return Math.min(length, target.length);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

/** The shape a renumber produces: one change per line, never adjacent. */
function renumberEveryLine(view: EditorView): void {
  view.dispatch({
    changes: Array.from({ length: RENUMBER_LINE_COUNT }, (_, index) => {
      const line = view.state.doc.line(index + 1);
      return { from: line.to - 1, to: line.to, insert: '9' };
    }),
  });
}

function getTableDecorations(view: EditorView): TableDecoration[] {
  const decorations: TableDecoration[] = [];
  const cursor = view.state.field(tableEditorField).decorations.iter();
  while (cursor.value) {
    const widget = cursor.value.spec.widget;
    if (widget instanceof TableEditorWidget) {
      decorations.push({ from: cursor.from, to: cursor.to, widget });
    }
    cursor.next();
  }
  return decorations;
}

describe('interactiveTableEditor', () => {
  it('seeds a fresh state unfocused, so a state swap has to hand it the view answer', () => {
    const view = setupEditor(TABLE);
    view.focus();
    expect(view.hasFocus, 'test setup could not focus the editor').toBe(true);

    // `create()` cannot see the view, and only focus EVENTS move the flag afterwards.
    expect(setupState(TABLE).field(tableEditorField).hasFocus).toBe(false);
    expect(tableFocusSyncEffect(view).value).toBe(true);
  });

  it('updates the table widget when typing inside a table', () => {
    const view = setupEditor(TABLE);
    const cellPosition = view.state.doc.toString().indexOf('x');

    view.dispatch({ changes: { from: cellPosition + 1, insert: '!' } });

    const [table] = getTableDecorations(view);
    expect(table.widget.sourceText).toContain('| x! | y |');
    expect(view.state.sliceDoc(table.from, table.to)).toBe(table.widget.sourceText);

    const cell = view.dom.querySelector<HTMLElement>('.sf-table__cell');
    expect(cell).not.toBeNull();
    cell!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.state.selection.main.anchor).toBe(table.to);
  });

  it('creates a table when typing the final separator-row delimiter', () => {
    const view = setupEditor('| A |\n| --- ');
    expect(getTableDecorations(view)).toHaveLength(0);

    view.dispatch({ changes: { from: view.state.doc.length, insert: '|' } });

    expect(getTableDecorations(view)).toHaveLength(1);
  });

  it('removes the table widget when deleting the separator row', () => {
    const view = setupEditor(TABLE);
    const separatorFrom = TABLE.indexOf('| ---');
    const separatorTo = TABLE.indexOf('\n', separatorFrom) + 1;

    view.dispatch({ changes: { from: separatorFrom, to: separatorTo } });

    expect(getTableDecorations(view)).toHaveLength(0);
  });

  it('leaves at the live table end after an edit above shifts the table', () => {
    const prefix = 'intro\n\n';
    const view = setupEditor(`${prefix}${TABLE}`);
    const previousFrom = getTableDecorations(view)[0].from;

    view.dispatch({ changes: { from: 0, insert: 'prefix ' } });

    const [table] = getTableDecorations(view);
    expect(table.from).toBe(previousFrom + 7);
    expect(table.widget.from).toBe(table.from);
    expect(table.widget.to).toBe(table.to);
    expect(view.state.sliceDoc(table.widget.from, table.widget.to)).toBe(TABLE);

    const cell = view.dom.querySelector<HTMLElement>('.sf-table__cell');
    expect(cell).not.toBeNull();
    cell!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(view.state.selection.main.anchor).toBe(table.to);
  });

  it('retains a mapped table beyond the parse frontier after an edit above it', () => {
    const prefix = Array.from(
      { length: 4_000 },
      (_, index) => `paragraph ${index} has enough text`,
    ).join('\n\n');
    const view = setupEditor(`${prefix}\n\n${TABLE}`);
    const previousFrom = getTableDecorations(view)[0].from;
    const insertedText = 'prefix ';

    // Restart parsing with the edit while preserving the existing table field.
    view.dispatch({
      changes: { from: 0, insert: insertedText },
      effects: StateEffect.reconfigure.of([
        createMarkdownLanguageSupport(),
        interactiveTableEditor,
      ]),
    });

    const tableFrom = previousFrom + insertedText.length;
    const parseFrontier = syntaxTree(view.state).length;
    expect(
      parseFrontier,
      `test setup parsed through the table (${parseFrontier}/${tableFrom})`,
    ).toBeLessThan(tableFrom);
    const tables = getTableDecorations(view);
    expect(tables).toHaveLength(1);
    expect(tables[0].from).toBe(tableFrom);
    expect(view.state.sliceDoc(tables[0].from, tables[0].to)).toBe(TABLE);
  });

  it('drops a touched table beyond the parse frontier until it is reparsed', () => {
    const prefix = Array.from(
      { length: 4_000 },
      (_, index) => `paragraph ${index} has enough text`,
    ).join('\n\n');
    const view = setupEditor(`${prefix}\n\n${TABLE}`);
    const tableFrom = getTableDecorations(view)[0].from;
    const separatorDash = tableFrom + TABLE.indexOf('---');

    view.dispatch({
      changes: { from: separatorDash, to: separatorDash + 1 },
      effects: StateEffect.reconfigure.of([
        createMarkdownLanguageSupport(),
        interactiveTableEditor,
      ]),
    });

    const parseFrontier = syntaxTree(view.state).length;
    expect(
      parseFrontier,
      `test setup parsed through the table (${parseFrontier}/${tableFrom})`,
    ).toBeLessThan(tableFrom);
    expect(getTableDecorations(view)).toHaveLength(0);
  });

  it('merges and splits adjacent tables when their blank separator changes', () => {
    const secondTable = '| C | D |\n| --- | --- |\n| z | w |';
    const view = setupEditor(`${TABLE}\n\n${secondTable}`);
    expect(getTableDecorations(view)).toHaveLength(2);

    view.dispatch({ changes: { from: TABLE.length, to: TABLE.length + 1 } });
    expect(getTableDecorations(view)).toHaveLength(1);

    view.dispatch({ changes: { from: TABLE.length, insert: '\n' } });
    expect(getTableDecorations(view)).toHaveLength(2);
  });

  it('does not scan the syntax tree for a selection-only update', () => {
    const view = setupEditor(`before\n\n${TABLE}\n\nafter`);
    iterateCalls.length = 0;

    view.dispatch({ selection: { anchor: view.state.doc.length } });

    expect(iterateCalls).toHaveLength(0);
    expect(getTableDecorations(view)).toHaveLength(1);
  });

  it('limits a small document edit to a local syntax-tree scan', () => {
    const paragraphs = Array.from({ length: 2_000 }, (_, index) => `paragraph ${index}`);
    const view = setupEditor(
      [`top paragraph`, ...paragraphs, TABLE, '| C |\n| --- |\n| z |'].join('\n\n'),
    );
    expect(view.state.field(tableEditorField).tables).toHaveLength(2);
    iterateCalls.length = 0;

    view.dispatch({ changes: { from: 3, insert: '!' } });

    expect(iterateCalls.length).toBeGreaterThan(0);
    expect(iterateCalls.every(({ from, to }) => from !== undefined && to !== undefined)).toBe(true);
    expect(Math.max(...iterateCalls.map(({ from, to }) => to! - from!))).toBeLessThan(500);
  });

  it('expands blocks once for a transaction that changes every line of one block', () => {
    // Expanding per change re-walked the whole block each time, costing
    // changes x block length. Counting reads keeps the guard deterministic.
    const view = setupOrderedListEditor();
    const lineSpy = spyOnLineReads(view);

    renumberEveryLine(view);

    expect(lineSpy).toHaveBeenCalled();
    // Expanding once is ~lineCount reads; once per change was ~lineCount^2.
    expect(lineSpy.mock.calls.length).toBeLessThan(READ_BOUND);
  });

  // The parse limit is the tree's length, and CM6 parses on a time budget, so a
  // slow machine reaches this path and a fast one does not. Pinning a short tree
  // makes it the same test everywhere: the test above passes on an unfixed build
  // whenever the parse happens to finish.
  it('expands blocks once when the tree is shorter than the document', () => {
    const view = setupOrderedListEditor();
    pinTreeLength(Math.floor(view.state.doc.length / 4));
    const lineSpy = spyOnLineReads(view);

    renumberEveryLine(view);

    expect(lineSpy).toHaveBeenCalled();
    expect(lineSpy.mock.calls.length).toBeLessThan(READ_BOUND);
  });
});
