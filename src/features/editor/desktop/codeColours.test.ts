// @vitest-environment jsdom
/* Syntax colours on the real engine's lines: what each code line draws once its block's grammar
 * arrived, and what an edit leaves before and after its block is read again. */
import { afterEach, expect, it, vi } from 'vitest';
import { EditorView } from './view';
import type { Applied } from '@futo-notes/editor/wasm-payloads';
import { Engine } from './engine';
import { drawnLineDrift } from './lineDrift';
import { offsetOf, pointInLine } from './lineElements';
import { loadEngineBuild } from './__test__/loadEngineBuild';

afterEach(() => vi.unstubAllGlobals());

async function openNote(source: string): Promise<{ view: EditorView; engine: Engine }> {
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
    edited() {},
    focusChanged() {},
    compositionEnded() {},
    toolbar() {},
    copyCode: async () => true,
  });
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  view.open(engine);
  return { view, engine };
}

/** Colour until nothing is left, grammars loaded included. */
async function coloured(view: EditorView): Promise<void> {
  const deadline = Date.now() + 5000;
  view.codeColours.colourNow();
  while (view.codeColours.pending()) {
    if (Date.now() > deadline) throw new Error('colouring never finished');
    await new Promise((resolve) => setTimeout(resolve, 5));
    view.codeColours.colourNow();
  }
}

/** Each piece line `index` draws in, its classes (`plain` for bare text) and its text. */
function drawnPieces(view: EditorView, index: number): string[] {
  return [...view.lineElements()[index].childNodes]
    .filter((node) => node.textContent)
    .map((node) => {
      const className = node instanceof HTMLElement ? node.className : 'plain';
      return `${className}:${node.textContent}`;
    });
}

function expectDrawnAsTheModel(view: EditorView): void {
  expect(drawnLineDrift(view.lineElements(), view.displayLines())).toBeNull();
}

it('colours a block by its language, its line still the engine text at every offset', async () => {
  const { view, engine } = await openNote('p\n```js\nconst a = "x"; // note\n```\nq');
  expect(drawnPieces(view, 1)).toEqual(['plain:const a = "x"; // note']);
  await coloured(view);
  expect(drawnPieces(view, 1)).toEqual([
    'tok-keyword:const',
    'plain: ',
    'tok-variableName tok-definition:a',
    'plain: ',
    'tok-operator:=',
    'plain: ',
    'tok-string:"x"',
    'tok-punctuation:;',
    'plain: ',
    'tok-comment:// note',
  ]);
  expectDrawnAsTheModel(view);
  const element = view.lineElements()[1];
  const line = view.displayLines()[1];
  for (let at = 0; at <= line.text.length; at++) {
    const [node, offset] = pointInLine(element, at);
    expect(offsetOf(view.dom, view.lineModel()!, node, offset)).toBe(line.start + at);
  }
  view.destroy();
  engine.free();
});

it('finds the grammar by name or alias whatever its case, and leaves others uncoloured', async () => {
  const { view, engine } = await openNote(
    '```JS\nlet a\n```\n~~~Rust\nfn x() {}\n~~~\n```PY\nx = 1\n```\n```sh\necho "hi"\n```\n```cobol\nMOVE A\n```\n```\nlet b\n```',
  );
  await coloured(view);
  const lines = view.displayLines();
  const kindsOf = (index: number) => lines[index].colours.map((run) => run.className);
  expect(kindsOf(0)).toContain('tok-keyword');
  expect(kindsOf(1)).toContain('tok-keyword');
  expect(kindsOf(2)).toContain('tok-number');
  expect(kindsOf(3)).toContain('tok-string');
  expect(drawnPieces(view, 4)).toEqual(['plain:MOVE A']);
  expect(drawnPieces(view, 5)).toEqual(['plain:let b']);
  expectDrawnAsTheModel(view);
  view.destroy();
  engine.free();
});

it('keeps the colours of a line typed in until its block is read again', async () => {
  const { view, engine } = await openNote('```js\nconst a = "xy";\n```');
  await coloured(view);
  const start = view.displayLines()[0].start;
  view.run((current) => current.replace({ start: start + 12, end: start + 12 }, 'z', 'Typing'));
  expect(drawnPieces(view, 0)).toContain('tok-string:"xzy"');
  expectDrawnAsTheModel(view);
  expect(view.codeColours.pending()).toBe(true);
  await coloured(view);
  expect(drawnPieces(view, 0)).toContain('tok-string:"xzy"');
  view.destroy();
  engine.free();
});

it('colours the lines after an edit that changes how they read', async () => {
  const { view, engine } = await openNote('```js\nlet a\nlet b\nlet c\n```');
  await coloured(view);
  expect(drawnPieces(view, 2)[0]).toBe('tok-keyword:let');
  const start = view.displayLines()[0].start;
  view.run((current) => current.replace({ start, end: start }, '/*', 'Typing'));
  await coloured(view);
  expect(drawnPieces(view, 1)).toEqual(['tok-comment:let b']);
  expect(drawnPieces(view, 2)).toEqual(['tok-comment:let c']);
  expectDrawnAsTheModel(view);
  view.destroy();
  engine.free();
});

it('colours a block again in its new language, and not at all once it has none', async () => {
  const { view, engine } = await openNote('```js\nlet a = 1\n```\n```js\nlet b\n```');
  await coloured(view);
  const at = view.lineModel()!.lines[0].byteStart;
  view.run((current) => current.setCodeBlockHeader({ at, language: 'python', name: '' }));
  await coloured(view);
  expect(drawnPieces(view, 0)[0]).toBe('tok-variableName:let');
  view.run((current) => current.setCodeBlockHeader({ at, language: '', name: '' }));
  await coloured(view);
  expect(drawnPieces(view, 0)).toEqual(['plain:let a = 1']);
  // The block touching it keeps its own.
  expect(drawnPieces(view, 1)[0]).toBe('tok-keyword:let');
  expectDrawnAsTheModel(view);
  view.destroy();
  engine.free();
});

it('draws a line that leaves its block without colours', async () => {
  const { view, engine } = await openNote('```js\nlet a\n```\nafter');
  await coloured(view);
  // The fence's text is the engine's: unwrapping the block keeps the line, now a paragraph.
  view.run((current) => current.blockCommand(view.bytes({ start: 0, end: 0 }), 'CodeBlock'));
  const line = view.displayLines().find((one) => one.text === 'let a');
  expect(line?.code ?? null).toBeNull();
  expectDrawnAsTheModel(view);
  await coloured(view);
  expectDrawnAsTheModel(view);
  view.destroy();
  engine.free();
});

it("keeps the engine's selection where it was when a block's colours arrive", async () => {
  const { view, engine } = await openNote('```js\nconst a = 1\n```');
  // jsdom focuses no contenteditable element, only one with a tab index.
  view.dom.tabIndex = 0;
  view.focus();
  // jsdom lays nothing out: the highlight drawn on the next frame measures no boxes.
  const measure = Range.prototype.getClientRects;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  view.selection.selectRange(9, 2);
  const ends = view.selection.ends();
  const revision = engine.revision;
  await coloured(view);
  expect(drawnPieces(view, 0)[0]).toBe('tok-keyword:const');
  expect(view.selection.range()).toEqual({ start: 2, end: 9 });
  expect(view.selection.ends()).toEqual(ends);
  expect(engine.revision).toBe(revision);
  Range.prototype.getClientRects = measure;
  view.destroy();
  engine.free();
});

it('loads no grammar for a note without a block that names a language', async () => {
  const { view, engine } = await openNote('# plain\n\n```\ncode\n```');
  await coloured(view);
  expect(view.codeColours.pending()).toBe(false);
  expect(drawnPieces(view, 2)).toEqual(['plain:code']);
  view.destroy();
  engine.free();
});

it('colours a block after any edit as a fresh read of the note colours it', async () => {
  const { view, engine } = await openNote(
    '```js\nconst a = "x";\n/* note */\nlet b = 2;\n```\n\n```py\ndef f():\n    return 1\n```',
  );
  await coloured(view);
  const at = (text: string): number =>
    view.displayLines().find((one) => one.text.includes(text))!.start;
  const caret = (offset: number) => view.bytes({ start: offset, end: offset });
  const edits: Array<(current: Engine) => Applied | null> = [
    (current) => current.replace({ start: at('= 2') + 4, end: at('= 2') + 4 }, '"', 'Typing'),
    (current) => current.paragraphKey(caret(at('/*') + 2), 'Enter'),
    (current) => current.paste(caret(at('def')), 'x = """\n'),
    (current) => current.paragraphKey(caret(at('let')), 'Backspace'),
    (current) => current.undo(),
    (current) => current.undo(),
  ];
  for (const edit of edits) {
    view.run(edit);
    expectDrawnAsTheModel(view);
    await coloured(view);
    expectDrawnAsTheModel(view);
    const fresh = await openNote(engine.draftText());
    await coloured(fresh.view);
    expect(view.displayLines().map((line) => line.colours)).toEqual(
      fresh.view.displayLines().map((line) => line.colours),
    );
    fresh.view.destroy();
    fresh.engine.free();
  }
  view.destroy();
  engine.free();
});
