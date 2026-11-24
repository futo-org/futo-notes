// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { EditorView } from './view';
import { Engine } from './engine';
import { loadEngineBuild } from './__test__/loadEngineBuild';

afterEach(() => vi.unstubAllGlobals());

async function openView(source: string): Promise<{ view: EditorView; engine: Engine }> {
  await loadEngineBuild();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const wrap = document.createElement('div');
  document.body.replaceChildren(wrap);
  const view = new EditorView(wrap, {
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
  });
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  view.open(engine);
  // jsdom focuses no contenteditable element, only one with a tab index.
  view.dom.tabIndex = 0;
  view.focus();
  return { view, engine };
}

function pressModEnter(view: EditorView): void {
  view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
  );
}

it('leaves a table from a middle row onto a new line after it, the table whole', async () => {
  const source = '| a | b |\n|---|---|\n| c | d |\n| e | f |\nnext';
  const { view, engine } = await openView(source);
  const at = source.indexOf('c');
  view.selection.selectRange(at, at);
  pressModEnter(view);
  expect(engine.draftText()).toBe('| a | b |\n|---|---|\n| c | d |\n| e | f |\n\nnext');
  const caret = source.indexOf('next');
  expect(view.selection.range()).toEqual({ start: caret, end: caret });
  view.destroy();
  engine.free();
});

it('opens a line below a plain line as before', async () => {
  const { view, engine } = await openView('one\ntwo');
  view.selection.selectRange(1, 1);
  pressModEnter(view);
  expect(engine.draftText()).toBe('one\n\ntwo');
  view.destroy();
  engine.free();
});
