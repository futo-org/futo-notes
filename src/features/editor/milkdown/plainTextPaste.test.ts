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
import type { EditorView } from '@milkdown/kit/prose/view';

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
  return !!view.someProp('handlePaste', (handler) => handler(view, event, null as never));
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
