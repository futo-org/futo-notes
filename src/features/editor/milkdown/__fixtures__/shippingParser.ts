/**
 * The shipping editor's markdown PARSER, built for real in jsdom — every plugin
 * of `MilkdownEditor.svelte`'s chain that changes what a note's bytes parse
 * into (the compat presets, the inline-break view, wikilinks, the table cell
 * `<br>` reader) and nothing that only renders or edits.
 *
 * The owned serializer's goldens (`tests/conformance/markdown-house-style.json`)
 * read their sources through this, so a golden passes only if the app itself
 * would read the bytes back as the same document.
 */
import { Editor, defaultValueCtx, parserCtx, rootCtx } from '@milkdown/kit/core';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import type { NodeJson } from '@futo-notes/editor/markdown';
import { softBreakView } from '../paragraphLines';
import { tableCellLineBreakRemark } from '../table/tableLineBreak';
import { wikilink } from '../wikilink';
import { withoutLeakedCtxTimers } from './noLeakedCtxTimers';

export interface ShippingParser {
  parse(markdown: string): NodeJson;
  destroy(): Promise<void>;
}

export async function createShippingParser(): Promise<ShippingParser> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await withoutLeakedCtxTimers(() =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
      })
      .use(commonmarkWithCompat())
      // Same order as MilkdownEditor.svelte: after the preset whose node it re-registers.
      .use(softBreakView)
      .use(gfmWithCompat())
      .use(wikilink)
      .use(tableCellLineBreakRemark)
      .create(),
  );
  const parser = editor.ctx.get(parserCtx);
  return {
    parse: (markdown) => parser(markdown).toJSON() as NodeJson,
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}
