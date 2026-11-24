// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { Applied } from '@futo-notes/editor/wasm-payloads';
import { EditorView } from './view';
import { Engine } from './engine';
import { takeOffer } from './takeOffer';
import { loadEngineBuild } from './__test__/loadEngineBuild';

afterEach(() => vi.unstubAllGlobals());

async function mounted(source: string, edited: (applied: Applied) => void = () => {}) {
  await loadEngineBuild();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const wrap = document.createElement('div');
  document.body.append(wrap);
  const view = new EditorView(wrap, {
    edited,
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    openLink() {},
    noteId: () => null,
  });
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  view.open(engine);
  return { view, engine };
}

it('shows the adoption without reporting an edit', async () => {
  const edited = vi.fn();
  const { view, engine } = await mounted('one two', edited);

  const adopted = takeOffer({ view, engine, source: 'zero one two' });

  expect(typeof adopted).toBe('object');
  expect(edited).not.toHaveBeenCalled();
  expect(engine.draftText()).toBe('zero one two');
  expect(view.dom.textContent).toContain('zero one two');
  view.destroy();
  engine.free();
});

it('waits while marked text is composing or another note is shown, and refuses what cannot be rebased', async () => {
  const { view, engine } = await mounted('---\ntitle: a\n---\nbody');
  const other = await Engine.restore({ token: 2, source: 'other', revision: 0, paused: false });

  expect(takeOffer({ view, engine: other, source: 'another' })).toBe('later');
  expect(takeOffer({ view, engine, source: '---\ntitle: b\n---\nbody' })).toBe('refused');
  expect(takeOffer({ view, engine, source: engine.draftText() })).toBe('refused');
  const end = engine.selection().end;
  engine.compose({ start: end, end }, 'x');
  expect(takeOffer({ view, engine, source: '---\ntitle: a\n---\nbody!' })).toBe('later');
  view.destroy();
  engine.free();
  other.free();
});
