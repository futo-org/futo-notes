// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Applied } from '@futo-notes/editor/wasm-payloads';
import { CODE_LANGUAGE_CLASS } from './codeBlockChrome';
import { EditorView } from './view';
import { Engine } from './engine';
import { loadEngineBuild } from './__test__/loadEngineBuild';

afterEach(() => vi.unstubAllGlobals());

function mountView(edited: (applied: Applied) => void = () => {}): EditorView {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const wrap = document.createElement('div');
  document.body.append(wrap);
  return new EditorView(wrap, {
    edited,
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    openLink() {},
    noteId: () => null,
  });
}

it('reads no selection once the note closes, though the selection stays in the editor', () => {
  const view = mountView();
  view.open(null);
  document.getSelection()!.collapse(view.dom, 0);
  expect(view.selection.range()).toBeNull();
});

it('shows the caret after a letter typed over itself, where the engine puts it', async () => {
  await loadEngineBuild();
  const engine = await Engine.restore({ token: 1, source: 'ab', revision: 0, paused: false });
  const view = mountView();
  view.open(engine);
  // jsdom focuses no contenteditable element, only one with a tab index.
  view.dom.tabIndex = 0;
  view.focus();
  view.selection.selectRange(1, 2);
  view.run((current) => current.replace({ start: 1, end: 2 }, 'b', 'Typing'));
  expect(engine.draftText()).toBe('ab');
  expect(engine.revision).toBe(0);
  expect(view.selection.range()).toEqual({ start: 2, end: 2 });
  expect(view.selection.ends()).toEqual({ anchor: 2, focus: 2 });
  view.destroy();
  engine.free();
});

it('writes a language typed in its field when the editor is torn down, out of the page', async () => {
  await loadEngineBuild();
  const source = '```\nlet alpha = 1\n```';
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const edited = vi.fn();
  const view = mountView(edited);
  view.open(engine);
  const language = view.dom.querySelector<HTMLInputElement>(`.${CODE_LANGUAGE_CLASS}`)!;
  language.focus();
  language.value = 'rust';
  // Svelte removes a component's DOM before its teardown runs.
  view.dom.parentElement!.remove();
  view.codeHeader.writeEditedHeader();
  expect(engine.draftText()).toBe('```rust\nlet alpha = 1\n```');
  expect(edited).toHaveBeenCalledOnce();
  view.destroy();
  engine.free();
});
