// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import type { InlineFormat } from '@futo-notes/editor/wasm-payloads';
import { Engine } from './engine';
import { EditorView } from './view';
import { formatButtons } from './formats';
import { loadEngineBuild } from './__test__/loadEngineBuild';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Display "Plain text, then sadasdasdasdbold, then plain.": "asdasdbold" (bold, starting
// mid-word) at 23..33, the whole word "sadasdasdasdbold" at 17..33.
const MID_WORD_BOLD = 'Plain text, then sadasd**asdasdbold**, then plain.';

/** The note `source` open in a view, display `start` to `end` selected. */
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
  document.body.replaceChildren(wrap);
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
  view.selection.sync();
  return { view, engine };
}

/** Whether toggling `format` changes the note at a selection, or what typing carries at a
 *  caret; a refusal (`UnrepresentableFormat`) changes nothing. */
function toggleActs(engine: Engine, format: InlineFormat): boolean {
  const before = JSON.stringify(engine.activeFormats());
  try {
    const applied = engine.toggleFormat(format);
    return applied !== null || JSON.stringify(engine.activeFormats()) !== before;
  } catch {
    return false;
  }
}

const INLINE: InlineFormat[] = ['Bold', 'Italic', 'Strike', 'Code'];

it('leaves Strike out of allowed over bold that starts mid-word, and in over the whole word', async () => {
  const refused = await viewOn(MID_WORD_BOLD, 23, 33);
  expect(refused.engine.toolbarState().allowed).not.toContain('Strike');
  refused.view.formatting.toggle('Strike');
  expect(refused.engine.draftText()).toBe(MID_WORD_BOLD);
  expect(formatButtons(refused.view.formatting.formats()!)[2]).toMatchObject({
    format: 'Strike',
    disabled: true,
  });
  refused.view.destroy();
  refused.engine.free();
  const whole = await viewOn(MID_WORD_BOLD, 17, 33);
  expect(whole.engine.toolbarState().allowed).toContain('Strike');
  expect(formatButtons(whole.view.formatting.formats()!)[2].disabled).toBe(false);
  whole.view.formatting.toggle('Strike');
  expect(whole.engine.draftText()).not.toBe(MID_WORD_BOLD);
  whole.view.destroy();
  whole.engine.free();
});

it('agrees with the toggle the desktop runs, over selections and at a caret', async () => {
  // [source, display start, display end]; a caret where they meet.
  const places: Array<[string, number, number]> = [
    [MID_WORD_BOLD, 23, 33],
    [MID_WORD_BOLD, 17, 33],
    // A strike starting mid-word ("asdasd" at 12..18).
    ['Plain dsadas~~asdasd~~ end', 12, 18],
    // Bold that ends inside the selection ("ld and mo").
    ['Plain **bold** and more', 8, 17],
    // Inline code, a wikilink, a code block's line.
    ['Plain `code` end', 6, 10],
    ['Plain [[Note]] end', 6, 10],
    ['```\ncode line\n```', 1, 4],
    // Carets: in plain text, in bold, in inline code, in a code block.
    ['Plain text here', 8, 8],
    ['Plain **bold** end', 8, 8],
    ['Plain `code` end', 8, 8],
    ['```\ncode line\n```', 2, 2],
  ];
  for (const [source, start, end] of places) {
    for (const format of INLINE) {
      const { view, engine } = await viewOn(source, start, end);
      const allowed = engine.toolbarState().allowed.includes(format);
      expect(toggleActs(engine, format), `${source} ${start}..${end} ${format}`).toBe(allowed);
      view.destroy();
      engine.free();
    }
  }
});

it('keeps carrying a format at a caret: Bold turned on for what is typed next', async () => {
  const { view, engine } = await viewOn('Plain text here', 6, 6);
  view.formatting.toggle('Bold');
  expect(engine.activeFormats()).toContain('Bold');
  expect(engine.draftText()).toBe('Plain text here');
  view.destroy();
  engine.free();
});
