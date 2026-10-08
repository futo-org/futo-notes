/**
 * A real Milkdown editor, in jsdom, for the wikilink round-trip tests.
 *
 * Deliberately the whole pipeline rather than the micromark extension alone:
 * what the tests need to know is what the document holds and what
 * `getMarkdown()` writes back — the two things a note on disk is made of. A
 * unit test of the tokenizer in isolation would pass while the mdast handler or
 * the node schema silently dropped the target. The compat presets, because
 * they are what installs the editor's own serializer — the writer under test.
 */
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { getMarkdown } from '@milkdown/kit/utils';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { wikilink } from '..';
import { WIKILINK_NODE } from '../node';
import { withoutLeakedCtxTimers } from '../../__fixtures__/noLeakedCtxTimers';

export interface RoundTrip {
  /** What `getMarkdown()` would save. */
  markdown: string;
  /** Every wikilink node's raw target, in document order. */
  targets: string[];
}

export async function roundTrip(source: string): Promise<RoundTrip> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await withoutLeakedCtxTimers(() =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, source);
      })
      .use(commonmarkWithCompat())
      .use(gfmWithCompat())
      .use(wikilink)
      .create(),
  );

  const markdown = editor.action(getMarkdown());
  const targets: string[] = [];
  editor.action((ctx) => {
    ctx.get(editorViewCtx).state.doc.descendants((node) => {
      if (node.type.name === WIKILINK_NODE) targets.push(node.attrs.target as string);
    });
  });

  await editor.destroy();
  root.remove();
  return { markdown, targets };
}
