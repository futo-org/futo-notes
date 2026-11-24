// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { BlockCommand } from '@futo-notes/editor/wasm-payloads';

import { BLOCK_ITEMS, blockButtons } from './blockButtons';
import { Engine } from './engine';
import { EditorView } from './view';
import { loadEngineBuild } from './__test__/loadEngineBuild';

afterEach(() => vi.unstubAllGlobals());

/** A view on `source` with UTF-16 display `start`..`end` selected, focused. */
async function viewOn(
  source: string,
  start: number,
  end: number,
): Promise<{ view: EditorView; engine: Engine }> {
  await loadEngineBuild();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const wrap = document.createElement('div');
  document.body.append(wrap);
  const view = new EditorView(wrap, {
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
    openLink() {},
    noteId: () => null,
  });
  view.open(engine);
  view.dom.tabIndex = 0;
  view.focus();
  view.selection.selectRange(start, end);
  return { view, engine };
}

const HEADING_2: BlockCommand = { ToggleHeading: 2 };

it('offers Heading 1, 2 and 3 and Quote from the manifest, in its order, without Text', () => {
  expect(BLOCK_ITEMS.map((item) => item.id)).toEqual([
    'heading-1',
    'heading-2',
    'heading-3',
    'quote',
  ]);
});

it('lights the level the lines share and Quote when it would take a level off', () => {
  const lit = (heading: number | null, quote: boolean): string[] =>
    blockButtons({ heading, headingAllowed: true, quote, quoteAllowed: true })
      .filter((button) => button.lit)
      .map((button) => button.id);
  expect(lit(2, false)).toEqual(['heading-2']);
  expect(lit(0, true)).toEqual(['quote']);
  expect(lit(null, false)).toEqual([]);
});

it('disables the heading buttons where no heading can apply, and Quote where it cannot', () => {
  const disabled = (headingAllowed: boolean, quoteAllowed: boolean): string[] =>
    blockButtons({ heading: null, headingAllowed, quote: false, quoteAllowed })
      .filter((button) => button.disabled)
      .map((button) => button.id);
  expect(disabled(false, true)).toEqual(['heading-1', 'heading-2', 'heading-3']);
  expect(disabled(true, false)).toEqual(['quote']);
});

it("greys every block button over a table's lines alone, by the engine's toolbar state", async () => {
  const { view, engine } = await viewOn('| a | b |\n|---|---|\n| c | d |', 2, 22);
  expect(view.formatting.formats()?.blocks).toEqual({
    heading: null,
    headingAllowed: false,
    quote: false,
    quoteAllowed: false,
  });
  view.destroy();
  engine.free();
});

it('a heading button turns the level the lines share off, else sets it, keeping the selection', async () => {
  // Display "one\ntwo": "one" 0..3, "two" 4..7.
  const { view, engine } = await viewOn('## one\n## two', 1, 6);
  view.formatting.block(HEADING_2);
  expect(engine.draftText()).toBe('one\ntwo');
  expect(view.selection.range()).toEqual({ start: 1, end: 6 });
  view.formatting.block(HEADING_2);
  expect(engine.draftText()).toBe('## one\n## two');
  expect(view.selection.range()).toEqual({ start: 1, end: 6 });
  view.run((current) => current.undo());
  expect(engine.draftText()).toBe('one\ntwo');
  view.destroy();
  engine.free();
});

it('a heading button on mixed levels sets the level, one Undo step', async () => {
  const { view, engine } = await viewOn('# one\n## two', 0, 7);
  view.formatting.block(HEADING_2);
  expect(engine.draftText()).toBe('## one\n## two');
  view.run((current) => current.undo());
  expect(engine.draftText()).toBe('# one\n## two');
  view.destroy();
  engine.free();
});

it('Quote takes a level off quoted lines and adds one to the others', async () => {
  const { view, engine } = await viewOn('> one\n> two', 1, 6);
  view.formatting.block('Quote');
  expect(engine.draftText()).toBe('one\ntwo');
  expect(view.selection.range()).toEqual({ start: 1, end: 6 });
  view.formatting.block('Quote');
  expect(engine.draftText()).toBe('> one\n> two');
  view.destroy();
  engine.free();
});

it('over text through a code block, heading and Quote change only the text lines', async () => {
  const { view, engine } = await viewOn('one\n```\ncode\n```\ntwo', 0, 0);
  const lines = view.lineModel()!.lines;
  const end = lines[lines.length - 1].start + lines[lines.length - 1].text.length;
  view.selection.selectRange(0, end);
  view.formatting.block(HEADING_2);
  expect(engine.draftText()).toBe('## one\n```\ncode\n```\n## two');
  view.run((current) => current.undo());
  view.selection.selectRange(0, end);
  view.formatting.block('Quote');
  expect(engine.draftText()).toBe('> one\n```\ncode\n```\n> two');
  view.destroy();
  engine.free();
});
