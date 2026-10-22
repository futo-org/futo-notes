// @vitest-environment jsdom
/*
 * RC-59's leftover: pasting a BLOCK as plain text into an EMPTY paragraph left
 * that paragraph above it, so an empty note saved with a leading blank line
 * (and an empty line in the middle of a note, where the caret was).
 *
 * `@milkdown/plugin-clipboard`'s plain-text route parses the text to a
 * document, round-trips it through the DOM and hands the slice to
 * `replaceSelection`; a slice that starts with a block lands after the empty
 * paragraph it was pasted into. `plainTextPaste.ts` replaces the paragraph.
 *
 * The paste goes through ProseMirror's own `handlePaste` chain — every plugin's
 * prop, in registration order — exactly as the browser's paste event does.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { TextSelection, Transaction } from '@milkdown/kit/prose/state';
import * as prosemirrorView from '@milkdown/kit/prose/view';
import type { EditorView } from '@milkdown/kit/prose/view';
import { splitListItem } from '@milkdown/kit/prose/schema-list';
import type { Slice } from '@milkdown/kit/prose/model';

import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';
import { guardEditorTimers } from './__fixtures__/editorTimerGuard';

guardEditorTimers();

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

interface EditorHandle {
  openNote: (noteId: string, text: string) => void;
  getContent: () => string | undefined;
  getProseMirrorView: () => EditorView | null;
}

const MilkdownEditor = (await import('./MilkdownEditor.svelte')).default;

async function mountEditor(content: string): Promise<EditorHandle> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  document.elementFromPoint = () => null;
  return withoutLeakedCtxTimers(async () => {
    const handle = mount(MilkdownEditor, {
      target,
      props: { content, onchange: () => {} },
    }) as unknown as EditorHandle;
    await vi.waitFor(() => expect(target.querySelector('.ProseMirror')).not.toBeNull(), {
      timeout: 30_000,
    });
    return handle;
  });
}

/** A plain-text paste: `text/plain` only, no `text/html`, as from a terminal or an editor. */
function pastePlain(view: EditorView, text: string): boolean {
  const event = {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  // The slice ProseMirror itself builds from the text, which every `handlePaste`
  // receives from a real paste (prosemirror-tables reads it and dies on null).
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
  const slice = parseFromClipboard(view, text, null, false, view.state.selection.$from);
  return !!view.someProp('handlePaste', (handler) => handler(view, event, slice));
}

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';

function blockTypes(view: EditorView): string[] {
  const types: string[] = [];
  view.state.doc.forEach((node) => types.push(node.type.name));
  return types;
}

describe('pasting a block as plain text into an empty paragraph (RC-59)', () => {
  it('a table into an empty note leaves no empty paragraph above it', async () => {
    const handle = await mountEditor('');
    const view = handle.getProseMirrorView()!;

    expect(pastePlain(view, TABLE)).toBe(true);

    expect(blockTypes(view)[0]).toBe('table');
    expect(handle.getContent()!.startsWith('|')).toBe(true);
  });

  it('a heading and a list into the empty line between two paragraphs replace that line', async () => {
    const handle = await mountEditor('');
    handle.openNote('test-note', 'alpha\n\nbeta\n');
    const view = handle.getProseMirrorView()!;
    // The empty line: split `alpha` at its end.
    view.dispatch(view.state.tr.split(view.state.doc.child(0).nodeSize - 1));
    expect(blockTypes(view)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    // The caret on that empty second paragraph.
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.doc.child(0).nodeSize + 1),
      ),
    );
    expect(view.state.selection.$from.parent.content.size).toBe(0);

    expect(pastePlain(view, '# Title\n\n- one\n- two\n')).toBe(true);

    expect(blockTypes(view).slice(0, 4)).toEqual([
      'paragraph',
      'heading',
      'bullet_list',
      'paragraph',
    ]);
  });

  it('a single line of text still pastes inline, into the paragraph', async () => {
    const handle = await mountEditor('');
    const view = handle.getProseMirrorView()!;

    expect(pastePlain(view, 'just words')).toBe(true);

    expect(blockTypes(view)).toEqual(['paragraph']);
    expect(handle.getContent()).toBe('just words\n');
  });

  it('a table pasted into a paragraph that has text is not touched', async () => {
    const handle = await mountEditor('');
    handle.openNote('test-note', 'keep me');
    const view = handle.getProseMirrorView()!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
      ),
    );

    pastePlain(view, TABLE);

    expect(blockTypes(view)[0]).toBe('paragraph');
    expect(view.state.doc.child(0).textContent).toContain('keep me');
  });
});

/*
 * R10-FB13-1 / -2: the plugin is for an empty paragraph that is a direct child
 * of the document (or a quote). Two other places an empty paragraph sits took
 * the same code path and regressed against the clipboard plugin's own route:
 *
 *  - the FIRST paragraph of a list item: the fitter keeps the item's empty
 *    filler paragraph and nests the pasted blocks under it (`- - x`), where the
 *    clipboard route appends a pasted list as siblings;
 *  - a table CELL: a lone `# x` fits the cell's content model, so the heading
 *    split the table in two instead of landing in the cell.
 */
describe('an empty paragraph that is not a document or quote child is left to the clipboard route', () => {
  function texts(view: EditorView, type: string): string[] {
    const found: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === type) found.push(node.textContent);
    });
    return found;
  }

  function count(view: EditorView, type: string): number {
    return texts(view, type).length;
  }

  it('a list pasted into an empty list item becomes siblings, not a nested list', async () => {
    const handle = await mountEditor('');
    handle.openNote('test-note', '- a\n- b\n');
    const view = handle.getProseMirrorView()!;
    // Enter at the end of `b`: a new, empty item.
    let endOfB = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'b') endOfB = pos + node.nodeSize - 1;
      return endOfB === -1;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, endOfB)));
    expect(splitListItem(view.state.schema.nodes.list_item)(view.state, view.dispatch)).toBe(true);
    expect(view.state.selection.$from.parent.content.size).toBe(0);

    pastePlain(view, '- x\n- y\n');

    expect(count(view, 'bullet_list')).toBe(1);
    expect(texts(view, 'list_item')).toEqual(['a', 'b', 'x', 'y']);
  });

  it('a lone heading pasted into an empty table cell does not split the table', async () => {
    const handle = await mountEditor('');
    handle.openNote('test-note', '| a | b |\n| --- | --- |\n| | y |\n');
    const view = handle.getProseMirrorView()!;
    let cell = -1;
    view.state.doc.descendants((node, pos) => {
      if (cell === -1 && node.type.name === 'table_cell' && node.textContent === '') cell = pos;
      return cell === -1;
    });
    expect(cell).toBeGreaterThanOrEqual(0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cell + 2)));
    expect(view.state.selection.$from.parent.content.size).toBe(0);

    pastePlain(view, '# x');

    expect(count(view, 'table')).toBe(1);
    expect(blockTypes(view)).not.toContain('heading');
    expect(view.state.doc.textContent).toContain('x');
  });
});

/*
 * RC-81: multi-line plain text pasted into a table cell OVERWROTE the cell next
 * to it. ProseMirror parses plain text to one paragraph per line; a cell holds
 * one line, so each paragraph was wrapped in a new cell and prosemirror-tables
 * pasted that run of cells over the row. `x<newline>` was enough (the trailing
 * newline is a second, empty paragraph). It needs no plugin of ours to be
 * involved at all, which is why it reproduces on base.
 */
describe('multi-line plain text pasted into a table cell keeps the neighboring cell (RC-81)', () => {
  async function pasteIntoEmptyCell(text: string): Promise<string> {
    const handle = await mountEditor('');
    handle.openNote('test-note', '| a | b |\n| --- | --- |\n| | y |\n');
    const view = handle.getProseMirrorView()!;
    let cell = -1;
    view.state.doc.descendants((node, pos) => {
      if (cell === -1 && node.type.name === 'table_cell' && node.textContent === '') cell = pos;
      return cell === -1;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cell + 2)));
    pastePlain(view, text);
    return handle.getContent()!;
  }

  it('a trailing newline does not spill into the next cell', async () => {
    const md = await pasteIntoEmptyCell('x\n');
    expect(md).toContain('y');
    expect(md).toMatch(/\|\s*x\s*\|\s*y\s*\|/);
  });

  it('two paragraphs land in the cell, joined, and the next cell survives', async () => {
    const md = await pasteIntoEmptyCell('p\n\nq');
    expect(md).toMatch(/\|\s*p q\s*\|\s*y\s*\|/);
  });

  it('a pasted list keeps every line and the next cell', async () => {
    const md = await pasteIntoEmptyCell('- a\n- b');
    expect(md).toContain('y');
    expect(md).toMatch(/a[^|]*b/);
  });
});

/*
 * A pasted block after text on a line merged its text into the paragraph and
 * lost its markup (`start` + `# Title` saved `startTitle`). The paragraph is
 * split at the caret instead; pasted text still runs on into its neighbors.
 */
describe('pasting blocks into a line that has text', () => {
  /** Opens `note` with the caret `offset` characters into its first paragraph. */
  async function caretIn(note: string, offset: number): Promise<[EditorHandle, EditorView]> {
    const handle = await mountEditor('');
    handle.openNote('test-note', note);
    const view = handle.getProseMirrorView()!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1 + offset)));
    return [handle, view];
  }

  it('a heading pasted mid-line splits the line around it, the caret after it', async () => {
    const [handle, view] = await caretIn('start\n', 3);

    expect(pastePlain(view, '# Title')).toBe(true);
    view.dispatch(view.state.tr.insertText('!'));

    expect(handle.getContent()).toBe('sta\n\n# Title!\n\nrt\n');
  });

  it('pasted paragraphs around a heading run on into the text either side', async () => {
    const [handle, view] = await caretIn('abcd\n', 2);

    expect(pastePlain(view, 'one\n\n# Two\n\nthree')).toBe(true);
    view.dispatch(view.state.tr.insertText('!'));

    expect(handle.getContent()).toBe('abone\n\n# Two\n\nthree!cd\n');
  });

  // Where a pasted line stops being characters (plainTextPaste.ts `literalLine`):
  // a marker with text after it, several indented lines and a divider are blocks.
  it('a numbered line with text is an ordered list, split out of the line', async () => {
    const [handle, view] = await caretIn('abcd\n', 2);

    expect(pastePlain(view, '1986. A great year')).toBe(true);

    expect(handle.getContent()).toBe('ab\n\n1986. A great year\n\ncd\n');
  });

  it('several indented lines are a code block', async () => {
    const [handle, view] = await caretIn('base\n', 4);

    expect(pastePlain(view, '    a\n    b')).toBe(true);

    expect(handle.getContent()).toBe('base\n\n```\na\nb\n```\n');
  });

  it('a divider is a block, split out of the line', async () => {
    const [, view] = await caretIn('abcd\n', 2);

    expect(pastePlain(view, '---')).toBe(true);

    // dividerCaret.ts then leaves the caret in an empty paragraph under it.
    expect(blockTypes(view).slice(0, 2)).toEqual(['paragraph', 'hr']);
    expect(view.state.doc.textContent).toBe('abcd');
  });

  it('a block marker alone, with a selection, replaces it with the characters', async () => {
    const [handle, view] = await caretIn('abcd\n', 1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2, 4)));

    expect(pastePlain(view, '>')).toBe(true);
    view.dispatch(view.state.tr.insertText('!'));

    expect(handle.getContent()).toBe('a>!d\n');
  });

  it('a list pasted at the start of a second line keeps the first line a paragraph', async () => {
    const [handle, view] = await caretIn('one\ntwo\n', 4);
    expect(view.state.selection.$from.nodeBefore?.type.name).toBe('hardbreak');

    expect(pastePlain(view, '- x\n- y')).toBe(true);

    expect(handle.getContent()).toBe('one\n\n- x\n- y\n\ntwo\n');
  });
});

describe('pasting blocks mid-line in a heading or a list item', () => {
  async function caretAfter(note: string, text: string): Promise<[EditorHandle, EditorView]> {
    const handle = await mountEditor('');
    handle.openNote('test-note', note);
    const view = handle.getProseMirrorView()!;
    let at = -1;
    view.state.doc.descendants((node, pos) => {
      if (at === -1 && node.isText && node.text!.includes(text)) {
        at = pos + node.text!.indexOf(text) + text.length;
      }
      return at === -1;
    });
    expect(at).toBeGreaterThan(0);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    return [handle, view];
  }

  it('a heading pasted mid-heading splits the heading around it', async () => {
    const [handle, view] = await caretAfter('## Head\n', 'He');

    expect(pastePlain(view, '# Title')).toBe(true);
    view.dispatch(view.state.tr.insertText('!'));

    expect(handle.getContent()).toBe('## He\n\n# Title!\n\n## ad\n');
  });

  it('a list pasted mid-item splits the item, the pasted items between its halves', async () => {
    const [handle, view] = await caretAfter('- item\n- next\n', 'it');

    expect(pastePlain(view, '- x\n- y')).toBe(true);
    view.dispatch(view.state.tr.insertText('!'));

    expect(handle.getContent()).toBe('- it\n- x\n- y!\n- em\n- next\n');
  });

  it('a list pasted at the end of an item with a sublist hands the sublist to the last pasted item', async () => {
    const [handle, view] = await caretAfter('- item\n  - sub\n', 'item');

    expect(pastePlain(view, '- x')).toBe(true);
    view.dispatch(view.state.tr.insertText('!'));

    expect(handle.getContent()).toBe('- item\n- x!\n  - sub\n');
  });

  it('a heading pasted at the start of a list item lands in the item ahead of its text', async () => {
    const [handle, view] = await caretAfter('- item\n', '');

    expect(pastePlain(view, '# T')).toBe(true);

    const md = handle.getContent()!;
    expect(md).toContain('# T');
    expect(md).toContain('item');
    expect(md).not.toMatch(/Titem|Item/);
  });
});

describe('a paste whose transaction throws', () => {
  it('falls through to the default paste instead of throwing out of the handler', async () => {
    const handle = await mountEditor('');
    handle.openNote('test-note', 'base');
    const view = handle.getProseMirrorView()!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.doc.content.size - 1),
      ),
    );
    const spy = vi.spyOn(Transaction.prototype, 'replaceSelection').mockImplementation(() => {
      throw new RangeError('boom');
    });
    try {
      expect(() => pastePlain(view, '**bold**')).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(view.state.doc.textContent).toBe('base');
  });
});
