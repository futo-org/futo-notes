// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mount } from 'svelte';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';
import {
  type EditorHandle,
  changes,
  target,
  handle,
  MilkdownEditor,
  useMountedEditor,
} from './__fixtures__/milkdownEditorHarness';

useMountedEditor();

/**
 * RC-38: micromark strips a leading U+FEFF, so Milkdown's remarkMarker read the
 * character BEFORE each `*`/`_` run and re-spelled every emphasis in the note.
 * `openNote` goes through parseNote, but the desktop tag bar's `applyEdit`
 * called Milkdown's own `replaceAll`, which did not — and reports the result
 * to the host synchronously, so the corruption was saved.
 */
describe('a note that starts with a byte order mark', () => {
  const BODY = 'Intro **b** and _it_ x**y**z\n';
  /* What a save writes for BODY: the house style spells italics `*`. */
  const SAVED = 'Intro **b** and *it* x**y**z\n';

  it('keeps its emphasis when the tag bar rewrites the document', () => {
    handle.openNote('test-note', `\ufeff${BODY}`);
    expect(handle.getContent()).toBe(`\ufeff${BODY}`);

    handle.applyEdit(`${handle.getContent()}\n#tag\n`);

    expect(changes.at(-1)).toBe(`${SAVED}\n#tag\n`);
    expect(handle.getContent()).toBe(`${SAVED}\n#tag\n`);
  });

  it('keeps its emphasis when the BOM is doubled, and echoes the host bytes on open', () => {
    const note = `\ufeff\ufeff${BODY}`;
    handle.openNote('test-note', note);
    expect(handle.getContent()).toBe(note);

    handle.applyEdit(`${note}\n#tag\n`);

    expect(changes.at(-1)).toBe(`${SAVED}\n#tag\n`);
  });
});

/**
 * The other two doors a string reaches the parser through without `parseNote`
 * (FB-8 follow-up): Milkdown's own `insert` action, and the `defaultValueCtx`
 * the engine is created with. Each strips the leading BOM itself
 * (`stripLeadingBoms`); nothing else pins either call, so removing one strip
 * would have kept the whole suite green while re-opening RC-38 through it.
 */
describe('the BOM strip on the parser doors other than openNote', () => {
  const BODY = 'Intro **b** and _it_ x**y**z\n';

  it('insertMarkdown keeps the emphasis of markdown that starts with a BOM', () => {
    handle.openNote('test-note', '');
    handle.insertMarkdown(`\ufeff${BODY}`);

    // The house style spells italics `*`.
    expect(handle.getContent()).toBe('Intro **b** and *it* x**y**z\n');
  });

  it('a note handed to the engine as its initial value keeps its emphasis', async () => {
    const mounted = document.createElement('div');
    document.body.appendChild(mounted);
    /* `applyExternal` replaces this document with a parseNote'd copy the moment
     * the engine is up, so only the instant BEFORE that — `onenginemounted` —
     * shows what `defaultValueCtx` built. Every mark's source spelling: `*` or `_`. */
    let markers: string[] | null = null;
    let initial!: EditorHandle;
    await withoutLeakedCtxTimers(async () => {
      initial = mount(MilkdownEditor, {
        target: mounted,
        props: {
          content: `\ufeff${BODY}`,
          onchange: () => {},
          onenginemounted: () => {
            const found: string[] = [];
            initial.getProseMirrorView()!.state.doc.descendants((node) => {
              for (const mark of node.marks) found.push(`${mark.type.name}:${mark.attrs.marker}`);
            });
            markers = found;
          },
        },
      }) as unknown as EditorHandle;
      await vi.waitFor(() => expect(markers).not.toBeNull());
    });

    expect(markers).toEqual(['strong:*', 'emphasis:_', 'strong:*']);
  });
});
