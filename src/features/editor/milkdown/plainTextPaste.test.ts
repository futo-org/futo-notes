// @vitest-environment jsdom
/*
 * RC-59's leftover: pasting a BLOCK as plain text into an EMPTY paragraph left
 * that paragraph above it, so an empty note saved with a leading blank line
 * (and an empty line in the middle of a note, where the caret was).
 *
 * `@milkdown/plugin-clipboard`'s plain-text route parses the text to a
 * document, round-trips it through the DOM and hands the slice to
 * `replaceSelection`; a slice that starts with a block lands after the empty
 * paragraph it was pasted into. `plainTextBlockPaste.ts` replaces the paragraph.
 *
 * The paste goes through ProseMirror's own `handlePaste` chain — every plugin's
 * prop, in registration order — exactly as the browser's paste event does.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { TextSelection } from '@milkdown/kit/prose/state';
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
  openNote: (text: string) => void;
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
    handle.openNote('alpha\n\nbeta\n');
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
    handle.openNote('keep me');
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
    handle.openNote('- a\n- b\n');
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
    handle.openNote('| a | b |\n| --- | --- |\n| | y |\n');
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
