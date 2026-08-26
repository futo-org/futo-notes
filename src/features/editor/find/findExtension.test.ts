// @vitest-environment jsdom

import { EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { markdownEditorLanguageExtensions } from '../codeMirrorMarkdown';
import { editorPointerInteractions } from '../interactions/editorPointerInteractions';
import { interactiveTableEditor } from '../table/interactiveTableEditor';
import { liveMarkdownTransform, selectionTouchesRange } from '../liveMarkdownTransform';
import { findExtension } from './findExtension';
import type { FindMatchReport } from './findMatches';
import { closeFind, findState, openFind } from './findState';

let view: EditorView | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  // jsdom ships no hit testing, and the pointer policy calls it on mousedown.
  document.elementFromPoint = () => null;
});

interface SetupOptions {
  nativeShell?: boolean;
  extraExtensions?: Extension[];
  onMatches?: (report: FindMatchReport) => void;
  onQueryFocus?: () => void;
}

function setup(doc: string, selection: EditorSelection, options: SetupOptions = {}): EditorView {
  const { extraExtensions = [], ...findOptions } = options;
  container = document.createElement('div');
  document.body.appendChild(container);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection,
      extensions: [
        ...markdownEditorLanguageExtensions(),
        liveMarkdownTransform,
        interactiveTableEditor,
        findExtension(findOptions),
        ...extraExtensions,
      ],
    }),
    parent: container,
  });
  view.contentDOM.blur();
  view.dom.blur();
  return view;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

afterEach(() => {
  view?.destroy();
  container?.remove();
  view = undefined;
  container = undefined;
});

describe('find extension', () => {
  it('reports query focus separately from editor-body focus', () => {
    const onQueryFocus = vi.fn();
    const editor = setup('cat', EditorSelection.cursor(0), { onQueryFocus });

    openFind(editor);

    expect(onQueryFocus).toHaveBeenCalled();
  });

  it('keeps the engine and reports canonical counts without a native-shell web panel', () => {
    const onMatches = vi.fn<(report: FindMatchReport) => void>();
    const editor = setup('cat dog CAT', EditorSelection.single(0, 3), {
      nativeShell: true,
      onMatches,
    });

    openFind(editor);

    expect(container?.querySelector('.cm-find-panel')).toBeNull();
    expect(onMatches).toHaveBeenLastCalledWith({
      query: 'cat',
      current: 1,
      total: 2,
      label: '1 of 2',
    });
    expect(editor.state.field(findState).open).toBe(true);
  });

  it('recomputes after a document edit without moving the editing selection', async () => {
    const editor = setup('cat middle cat', EditorSelection.single(0, 3), {
      nativeShell: true,
    });
    openFind(editor);

    editor.dispatch({
      changes: { from: 4, insert: 'X' },
      selection: EditorSelection.cursor(5),
    });
    await settle();

    expect(editor.state.selection.main).toMatchObject({ from: 5, to: 5 });
    expect(editor.state.field(findState).matches).toEqual([
      { from: 0, to: 3 },
      { from: 12, to: 15 },
    ]);
  });

  it('reveals a current match inside hidden link syntax while the editor is unfocused', async () => {
    const doc = '[label](secret-url)';
    const from = doc.indexOf('secret');
    const editor = setup(doc, EditorSelection.single(from, from + 'secret'.length), {
      nativeShell: true,
    });
    expect(editor.hasFocus).toBe(false);

    openFind(editor);
    await settle();

    expect(selectionTouchesRange(editor.state, false, [], 0, doc.length)).toBe(true);
    expect(container?.textContent).toContain('secret-url');

    closeFind(editor);
    await settle();
    expect(selectionTouchesRange(editor.state, false, [], 0, doc.length)).toBe(false);
  });

  it('reveals source when the current match is inside an interactive table widget', async () => {
    const doc = '| Name |\n| --- |\n| needle |';
    const from = doc.indexOf('needle');
    const editor = setup(doc, EditorSelection.single(from, from + 'needle'.length));
    await settle();
    expect(container?.querySelector('.sf-table')).not.toBeNull();

    openFind(editor);
    await settle();

    expect(container?.querySelector('.sf-table')).toBeNull();
    expect(container?.textContent).toContain('| needle |');
  });

  it('keeps the current match reveal frozen across pointer selection cleanup', async () => {
    const doc = '[label](secret-url)';
    const from = doc.indexOf('secret');
    const editor = setup(doc, EditorSelection.single(from, from + 'secret'.length), {
      nativeShell: true,
      extraExtensions: [
        editorPointerInteractions({
          profile: 'desktop',
          activateLink: () => {},
          onWindowBlur: () => {},
        }),
      ],
    });
    openFind(editor);
    await settle();

    editor.contentDOM.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await settle();

    expect(selectionTouchesRange(editor.state, false, [], from, from + 'secret'.length)).toBe(true);
    expect(container?.textContent).toContain('secret-url');
  });

  it('renders the panel, updates its count after a frame, steps, and closes on Escape', async () => {
    const editor = setup('cat dog CAT', EditorSelection.cursor(0));
    openFind(editor);
    const input = container?.querySelector<HTMLInputElement>('.cm-find-query');
    expect(input).not.toBeNull();
    expect(input?.closest('.cm-panels-bottom')).not.toBeNull();

    input!.value = 'cat';
    input!.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await settle();

    expect(container?.querySelector('.cm-find-count')?.textContent).toBe('1 of 2');
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editor.state.selection.main.from).toBe(8);
    expect(container?.querySelector('.cm-find-count')?.textContent).toBe('2 of 2');

    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(editor.state.selection.main.from).toBe(0);

    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(editor.state.field(findState).open).toBe(false);
    expect(container?.querySelector('.cm-find-panel')).toBeNull();
    expect(container?.querySelector('.cm-find-match')).toBeNull();
  });
});
