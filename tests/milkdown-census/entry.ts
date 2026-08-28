/**
 * Browser side of the round-trip census.
 *
 * Builds a real Milkdown editor with the app's core plugin chain and load
 * sequence, and exposes one function that reports what a note's bytes look like
 * after the editor has read and written them back.
 *
 * SCOPE: commonmark + gfm, which is what the compat plugins act on. It does NOT
 * mount the wikilink plugin the app also uses (#101): that reaches into
 * `$features/notes/notes.svelte` for the note index, so bundling it here would
 * mean pulling the Svelte app state into an esbuild browser bundle. Wikilink
 * round-tripping has its own differential and embed-seam coverage under
 * `src/features/editor/milkdown/wikilink/`; a note whose ONLY round-trip
 * difference is wikilink escaping therefore reads as a difference here that the
 * shipping editor does not have.
 *
 * Two variants share this file so the census can measure a change rather than a
 * snapshot: `compat` is what the app ships, `baseline` is the unpatched
 * upstream preset. `milkdown-compat.canary.spec.ts` uses `baseline` to prove
 * the upstream bugs are still there — the day one is fixed upstream, its canary
 * fails and the corresponding local fork should be deleted.
 */
import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { history } from '@milkdown/kit/plugin/history';
import { listener } from '@milkdown/kit/plugin/listener';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';

import { commonmarkWithCompat } from '@futo-notes/editor/milkdown-compat';

export type CensusVariant = 'compat' | 'baseline';

/** One pass of the editor over a note: what went in, what came back out. */
export interface RoundTrip {
  markdown: string;
  /** Node- and mark-type histogram of the resulting ProseMirror document. */
  histogram: Record<string, number>;
  /** Visible text with runs of whitespace collapsed. */
  text: string;
  /** ProseMirror's own structural comparison needs the doc, which cannot cross
   *  the page boundary — so the JSON goes instead and the driver compares that. */
  docJson: unknown;
}

function histogram(doc: ProseNode): Record<string, number> {
  const counts: Record<string, number> = {};
  doc.descendants((node) => {
    counts[node.type.name] = (counts[node.type.name] ?? 0) + 1;
    for (const mark of node.marks)
      counts[`mark:${mark.type.name}`] = (counts[`mark:${mark.type.name}`] ?? 0) + 1;
    return true;
  });
  return counts;
}

function visibleText(doc: ProseNode): string {
  return doc.textBetween(0, doc.content.size, ' ', ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Mirrors `MilkdownEditor.svelte`'s load path exactly: `defaultValueCtx` at
 * creation followed by an immediate `replaceAll` of the same content, which is
 * what `applyExternal` does. Reading a `defaultValueCtx`-only editor manufactures
 * instability on every list/table/quote/fence note, because the `trailing`
 * plugin has not settled — that mistake cost the first census run.
 */
async function loadOnce(variant: CensusVariant, markdown: string): Promise<RoundTrip> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const preset = variant === 'compat' ? commonmarkWithCompat() : commonmark;
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(preset)
    .use(gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(cursor)
    .use(trailing)
    .create();
  try {
    if (markdown !== '') editor.action(replaceAll(markdown));
    const out = editor.action(getMarkdown());
    const doc = editor.ctx.get(editorViewCtx).state.doc;
    return {
      markdown: out,
      histogram: histogram(doc),
      text: visibleText(doc),
      docJson: doc.toJSON(),
    };
  } finally {
    await editor.destroy();
    root.remove();
  }
}

declare global {
  interface Window {
    __futoCensus: {
      load: (variant: CensusVariant, markdown: string) => Promise<RoundTrip>;
    };
  }
}

window.__futoCensus = { load: loadOnce };
