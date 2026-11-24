// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { FindBarState } from './findInNote';
import { EditorView } from './view';
import { Engine } from './engine';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(async () => {
  await loadEngineBuild();
  // jsdom measures no text: a range's box is one 8px-wide row at the top of the page.
  Range.prototype.getClientRects = function (): DOMRectList {
    return [new DOMRect(0, 0, 8, 24)] as unknown as DOMRectList;
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

interface Mounted {
  view: EditorView;
  engine: Engine;
  bar: () => FindBarState | null;
}

async function mount(source: string): Promise<Mounted> {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const wrap = document.createElement('div');
  document.body.append(wrap);
  let bar: FindBarState | null = null;
  const view = new EditorView(wrap, {
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    findBar: (state) => (bar = state),
  });
  view.open(engine);
  // jsdom focuses no contenteditable element, only one with a tab index.
  view.dom.tabIndex = 0;
  return { view, engine, bar: () => bar };
}

function drawnBands(view: EditorView): string[] {
  const layer = view.dom.parentElement!.querySelector('.desktop-find')!;
  return [...layer.children].map((band) =>
    band.classList.contains('current') ? 'current' : 'match',
  );
}

it('opens on the selection within one line, counts and draws its matches, the current one marked', async () => {
  const { view, engine, bar } = await mount('a **bo**ld Bold\n\nBOLD and bold');
  view.selection.selectRange(2, 6);
  view.find.open();
  expect(bar()).toMatchObject({ open: true, query: 'bold', label: '1 of 4', hasMatches: true });
  expect(view.find.puppetState()).toEqual({ open: true, query: 'bold', current: 1, total: 4 });
  view.find.paint();
  expect(drawnBands(view)).toEqual(['current', 'match', 'match', 'match']);
  view.destroy();
  engine.free();
});

it('lands on the current match first, then steps with wrap, never editing the note', async () => {
  const { view, engine } = await mount('cat dog cat');
  view.find.open();
  view.find.setQuery('cat');
  await new Promise(requestAnimationFrame);
  expect(view.selection.range()).toEqual({ start: 0, end: 0 });
  view.find.step(1);
  expect(view.selection.range()).toEqual({ start: 0, end: 3 });
  view.find.step(1);
  expect(view.selection.range()).toEqual({ start: 8, end: 11 });
  view.find.step(1);
  expect(view.find.puppetState().current).toBe(1);
  view.find.step(-1);
  expect(view.selection.range()).toEqual({ start: 8, end: 11 });
  expect(engine.draftText()).toBe('cat dog cat');
  expect(engine.revision).toBe(0);
  view.destroy();
  engine.free();
});

it('reads zero matches as 0 and steps nowhere', async () => {
  const { view, engine, bar } = await mount('cat');
  view.find.open();
  view.find.setQuery('zebra');
  await new Promise(requestAnimationFrame);
  expect(bar()).toMatchObject({ label: '0', hasMatches: false });
  view.find.step(1);
  expect(view.selection.range()).toEqual({ start: 0, end: 0 });
  view.destroy();
  engine.free();
});

it('keeps find open through an edit and rescans once input settles', async () => {
  const { view, engine } = await mount('cat\n');
  view.find.open();
  view.find.setQuery('cat');
  await new Promise(requestAnimationFrame);
  vi.useFakeTimers();
  view.selection.selectRange(4, 4);
  view.run((live) => live.replace({ start: 4, end: 4 }, 'cat', 'Typing'));
  expect(view.find.puppetState().total).toBe(1);
  vi.advanceTimersByTime(150);
  expect(view.find.puppetState()).toMatchObject({ open: true, total: 2 });
  view.destroy();
  engine.free();
});

it('closes with the caret at the current match end, the query kept', async () => {
  const { view, engine, bar } = await mount('one cat');
  view.find.open();
  view.find.setQuery('cat');
  await new Promise(requestAnimationFrame);
  view.find.close();
  expect(bar()?.open).toBe(false);
  expect(view.selection.range()).toEqual({ start: 7, end: 7 });
  expect(view.find.suppressesToolbar()).toBe(false);
  view.find.paint();
  expect(drawnBands(view)).toEqual([]);
  view.selection.selectRange(0, 0);
  view.find.open();
  expect(bar()).toMatchObject({ open: true, query: 'cat' });
  view.destroy();
  engine.free();
});

it('closes when another note opens, and steps nothing while closed', async () => {
  const { view, engine, bar } = await mount('cat');
  view.find.open();
  view.find.setQuery('cat');
  await new Promise(requestAnimationFrame);
  view.open(null);
  expect(bar()?.open).toBe(false);
  view.open(engine);
  view.find.step(1);
  expect(view.selection.range()).toEqual({ start: 0, end: 0 });
  view.destroy();
  engine.free();
});

it('keeps the current match marked through an edit before it, before any rescan', async () => {
  const { view, engine } = await mount('x cat cat');
  view.selection.selectRange(4, 4);
  view.find.open();
  view.find.setQuery('cat');
  await new Promise(requestAnimationFrame);
  view.find.paint();
  expect(drawnBands(view)).toEqual(['match', 'current']);
  view.selection.selectRange(0, 0);
  view.run((live) => live.replace({ start: 0, end: 0 }, 'yy', 'Typing'));
  view.find.paint();
  expect(drawnBands(view)).toEqual(['match', 'current']);
  view.destroy();
  engine.free();
});

it('lands on the match and closes after it in UTF-16 offsets past wider characters', async () => {
  const { view, engine } = await mount('😀 ΟΔΟΣΑ é οδος');
  view.find.open();
  view.find.setQuery('οδοσ');
  await new Promise(requestAnimationFrame);
  expect(view.find.puppetState()).toMatchObject({ current: 1, total: 2 });
  view.find.step(1);
  expect(view.selection.range()).toEqual({ start: 3, end: 7 });
  view.find.step(1);
  expect(view.selection.range()).toEqual({ start: 11, end: 15 });
  view.find.close();
  expect(view.selection.range()).toEqual({ start: 15, end: 15 });
  view.destroy();
  engine.free();
});

it('draws nothing for a cleared query, which reads 0', async () => {
  const { view, engine, bar } = await mount('cat');
  view.find.open();
  view.find.setQuery('cat');
  await new Promise(requestAnimationFrame);
  view.find.setQuery('');
  await new Promise(requestAnimationFrame);
  view.find.paint();
  expect(drawnBands(view)).toEqual([]);
  expect(bar()).toMatchObject({ open: true, query: '', label: '0', hasMatches: false });
  view.destroy();
  engine.free();
});
