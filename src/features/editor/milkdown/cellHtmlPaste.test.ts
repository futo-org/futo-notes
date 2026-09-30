// @vitest-environment jsdom
/*
 * RC-83: a paste carrying `text/html` with several blocks, with the caret in a
 * table cell, replaced the caret cell's own text AND the next cell's.
 *
 * A GFM cell holds one line of inline content, so ProseMirror's HTML parser
 * wraps each pasted `<p>` in a NEW CELL, and prosemirror-tables' own
 * `handlePaste` then pastes that run of cells over the cells from the caret on:
 * `| c1 | c2 |` + caret at the end of `c1` + `<p>Kn5 p</p><p>Kn6 q</p>` saved
 * `| Kn5 p | Kn6 q |`. (The plain-text twin of this is RC-81.)
 *
 * What must NOT change: a pasted `<table>`/row/cell is a spreadsheet paste and
 * overwrites cell by cell on purpose, and a CellSelection (several cells picked)
 * pastes into the picked cells, as before.
 *
 * The paste goes through ProseMirror's own `handlePaste` chain, with the slice
 * ProseMirror itself builds from the HTML (`transformPastedHTML` included),
 * exactly as the browser's paste event does.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { TextSelection } from '@milkdown/kit/prose/state';
import { CellSelection } from '@milkdown/kit/prose/tables';
import * as prosemirrorView from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Slice } from '@milkdown/kit/prose/model';

import { flattenHtmlBlocks } from './cellHtmlFlatten';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';
import { guardEditorTimers } from './__fixtures__/editorTimerGuard';

guardEditorTimers();

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

interface EditorHandle {
  openNote: (text: string) => void;
  getContent: () => string | undefined;
  getProseMirrorView: () => EditorView | null;
}

const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;

async function mountEditor(): Promise<EditorHandle> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  document.elementFromPoint = () => null;
  return withoutLeakedCtxTimers(async () => {
    const handle = mount(MilkdownEditor, {
      target,
      props: { content: '', onchange: () => {} },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull(), {
      timeout: 30_000,
    });
    return handle;
  });
}

/** An HTML paste (with its plain-text twin, as browsers send both). */
function pasteHtml(view: EditorView, html: string, text = 'x'): boolean {
  const event = {
    clipboardData: {
      getData: (type: string) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
    },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  const parseFromClipboard = (
    prosemirrorView as unknown as {
      __parseFromClipboard: (
        view: EditorView,
        text: string,
        html: string | null,
        plain: boolean,
        $context: unknown,
      ) => Slice;
    }
  ).__parseFromClipboard;
  const slice = parseFromClipboard(view, text, html, false, view.state.selection.$from);
  return !!view.someProp('handlePaste', (handler) => handler(view, event, slice));
}

const NOTE = '| a | b |\n| --- | --- |\n| c1 | c2 |\n';

/** Opens NOTE with the caret at the end of the `c1` cell. */
async function openWithCaretInC1(): Promise<{ handle: EditorHandle; view: EditorView }> {
  const handle = await mountEditor();
  handle.openNote(NOTE);
  const view = handle.getProseMirrorView()!;
  let end = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === 'c1') end = pos + node.nodeSize - 1;
    return end === -1;
  });
  expect(end).toBeGreaterThan(0);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
  return { handle, view };
}

/** The body row of the saved table, cells trimmed. */
function bodyRow(markdown: string): string[] {
  const rows = markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => cell.trim()),
    );
  return rows[rows.length - 1];
}

describe('several HTML blocks pasted into a table cell stay in that cell (RC-83)', () => {
  it('two paragraphs join after the caret and the next cell survives', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<p>Kn5 p</p><p>Kn6 q</p>');

    expect(bodyRow(handle.getContent()!)).toEqual(['c1Kn5 p Kn6 q', 'c2']);
  });

  it('a list joins its items', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<ul><li>one</li><li>two</li></ul>');

    expect(bodyRow(handle.getContent()!)).toEqual(['c1one two', 'c2']);
  });

  it('a heading and a paragraph join', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<h1>Title</h1><p>body</p>');

    expect(bodyRow(handle.getContent()!)).toEqual(['c1Title body', 'c2']);
  });

  it('bold and a link keep their marks', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<p><b>bold</b> and <a href="https://e.example/">link</a></p><p>tail</p>');

    const row = bodyRow(handle.getContent()!);
    expect(row[1]).toBe('c2');
    expect(row[0]).toContain('**bold**');
    expect(row[0]).toContain('[link](https://e.example/)');
    expect(row[0]).toContain('tail');
  });

  it('a single inline run still pastes where it always did', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<span>just</span>');

    expect(bodyRow(handle.getContent()!)).toEqual(['c1just', 'c2']);
  });
});

describe('what stays spreadsheet-style (unchanged)', () => {
  it('a pasted HTML table overwrites cell by cell', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<table><tr><td>X</td><td>Y</td></tr></table>');

    expect(bodyRow(handle.getContent()!)).toEqual(['X', 'Y']);
  });

  it('paragraphs pasted over a CellSelection land in the selected cells', async () => {
    const { handle, view } = await openWithCaretInC1();
    const cells: number[] = [];
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'table_cell') cells.push(pos);
    });
    // The two body cells: the last two `table_cell`s.
    const [first, second] = cells.slice(-2);
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, first, second) as unknown as TextSelection,
      ),
    );

    pasteHtml(view, '<p>P</p><p>Q</p>');

    expect(bodyRow(handle.getContent()!)).toEqual(['P', 'Q']);
  });
});

/*
 * R10 round on RC-83: the flatten put a space AFTER each block only, so an inline
 * run meeting a block fused two words (`Kn1 a` + `<p>Kn2 b</p>` -> `Kn1 aKn2 b`);
 * a huge sibling list overflowed the stack in the spread; a custom element whose
 * name starts with `table` switched the flatten off; and a blank paste inserted
 * a non-breaking space where blank plain text pastes nothing.
 */
describe('the flatten keeps words apart, survives size, and reads the DOM, not the string', () => {
  it('an inline run followed by a block does not fuse with it', async () => {
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<span>Kn1 a</span><p>Kn2 b</p>');

    expect(bodyRow(handle.getContent()!)).toEqual(['c1Kn1 a Kn2 b', 'c2']);
  });

  it('a block followed by an inline run, a nested list and marks stay apart', () => {
    expect(flattenHtmlBlocks('Kn3 a<div>Kn4 b</div>')).toBe('Kn3 a Kn4 b');
    expect(flattenHtmlBlocks('<ul><li>Kn5 a<ul><li>Kn6 b</li></ul></li></ul>')).toBe('Kn5 a Kn6 b');
    expect(flattenHtmlBlocks('<b>x</b><p>y</p>')).toBe('<b>x</b> y');
  });

  it('never leaves a double space or a space at either end', () => {
    expect(flattenHtmlBlocks('<p> a </p><p> b </p>')).toBe('a b');
    expect(flattenHtmlBlocks('<ul><li><p>a</p></li><li><p>b</p></li></ul>')).toBe('a b');
  });

  it('a very long run of siblings does not overflow the stack', () => {
    const html = `<p>${'<b>x</b>'.repeat(150_000)}</p><p>z</p>`;

    const flat = flattenHtmlBlocks(html);

    expect(flat).not.toBeNull();
    expect(flat!.endsWith(' z')).toBe(true);
  }, 60_000);

  it('a custom element that merely starts with "table" is not a table', async () => {
    expect(flattenHtmlBlocks('<p>a <table-of-contents>x</table-of-contents></p><p>b</p>')).toBe(
      'a <table-of-contents>x</table-of-contents> b',
    );
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<p>Kn42 <table-of-contents>x</table-of-contents></p><p>Kn43 z</p>');

    const row = bodyRow(handle.getContent()!);
    expect(row[1]).toBe('c2');
    expect(row[0]).toContain('Kn43 z');
  });

  it('a real table anywhere in the paste is still left alone', () => {
    expect(flattenHtmlBlocks('<div><table><tr><td>a</td></tr></table></div>')).toBeNull();
    expect(flattenHtmlBlocks('<td>a</td><td>b</td>')).toBeNull();
  });

  it('a whitespace-only paste pastes nothing', async () => {
    expect(flattenHtmlBlocks('<p> </p><p>&nbsp;</p>')).toBe('');
    const { handle, view } = await openWithCaretInC1();

    pasteHtml(view, '<p> </p><p>&nbsp;</p>', ' \n\u00a0');

    expect(bodyRow(handle.getContent()!)).toEqual(['c1', 'c2']);
  });

  it('an image is not blank text', () => {
    expect(flattenHtmlBlocks('<p><img src="a.png"></p><p> </p>')).toContain('<img');
  });
});
