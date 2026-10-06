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
 * Two variants share this file so the census can measure a change rather than
 * a snapshot: `compat` is what the app ships — the compat presets, which read
 * through the parse-side fixes and write through the editor's own serializer
 * (`@futo-notes/editor/markdown`, #266) — and `baseline` is the unpatched
 * upstream preset, reading and writing with remark.
 * `tests/editor-embed-milkdown-compat.spec.ts` uses `baseline` to prove the
 * upstream bugs are still there — the day one is fixed upstream, its canary
 * fails and the corresponding local fork should be deleted.
 */
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  rootCtx,
  serializerCtx,
} from '@milkdown/kit/core';
import { commonmark } from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { clipboard } from '@milkdown/kit/plugin/clipboard';
import { cursor } from '@milkdown/kit/plugin/cursor';
import { history } from '@milkdown/kit/plugin/history';
import { listener } from '@milkdown/kit/plugin/listener';
import { trailing } from '@milkdown/kit/plugin/trailing';
import { getMarkdown, replaceAll } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Selection } from '@milkdown/kit/prose/state';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';

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
  /** `markdown` parsed and written again: a second save (`second_pass_unstable`). */
  secondPass: string;
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
  const patched = variant === 'compat';
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(patched ? commonmarkWithCompat() : commonmark)
    .use(patched ? gfmWithCompat() : gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(cursor)
    .use(trailing)
    .create();
  try {
    if (markdown !== '') editor.action(replaceAll(markdown));
    const doc = editor.ctx.get(editorViewCtx).state.doc;
    const out = editor.action(getMarkdown());
    const secondPass = editor.ctx.get(serializerCtx)(editor.ctx.get(parserCtx)(out));
    return {
      markdown: out,
      histogram: histogram(doc),
      text: visibleText(doc),
      docJson: doc.toJSON(),
      secondPass,
    };
  } finally {
    await editor.destroy();
    root.remove();
  }
}

/** What one keystroke inside a heading does to that heading's own markup. */
export interface HeadingEditChurn {
  /** The heading's `id` attribute before and after the edit. */
  idBefore: string;
  idAfter: string;
  /** False when the edit re-created the element the caret was in. */
  sameElement: boolean;
}

/**
 * Types one character into a heading and reports whether the heading's markup
 * changed underneath it.
 *
 * The measurement behind dropping upstream's `syncHeadingIdPlugin` (see
 * `@futo-notes/editor/milkdown-compat`): it re-stamps every heading's slug `id`
 * after any document change, which changes the caret's own block, and
 * ProseMirror answers an attribute change by re-creating the element. On
 * WKWebView the next character then lands at the start of the block, so typing
 * comes out reversed. Deliberately NOT a keyboard test — the ProseMirror
 * transaction is the input the plugin reacts to, and asserting on it is
 * engine-independent, so the canary runs anywhere the suite does.
 */
async function headingEditChurn(
  variant: CensusVariant,
  markdown: string,
): Promise<HeadingEditChurn> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const preset = variant === 'compat' ? commonmarkWithCompat() : commonmark;
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(preset)
    .use(variant === 'compat' ? gfmWithCompat() : gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(cursor)
    .use(trailing)
    .create();
  try {
    editor.action(replaceAll(markdown));
    const view = editor.ctx.get(editorViewCtx);
    const before = view.dom.querySelector('h1');
    const idBefore = before?.id ?? '';
    // At the end of the heading's text, which is where a user types.
    const heading = view.state.doc.firstChild;
    const at = (heading?.nodeSize ?? 1) - 1;
    view.dispatch(view.state.tr.insertText('X', at));
    const after = view.dom.querySelector('h1');
    return {
      idBefore,
      idAfter: after?.id ?? '',
      sameElement: before !== null && before === after,
    };
  } finally {
    await editor.destroy();
    root.remove();
  }
}

/**
 * Pastes `markdown` as plain text into an empty editor and returns what it
 * saves. Dispatched as a real `paste` event, so it takes Milkdown's own
 * clipboard route: markdown parsed, serialized to DOM, and parsed back.
 */
async function pastePlainText(variant: CensusVariant, markdown: string): Promise<string> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const preset = variant === 'compat' ? commonmarkWithCompat() : commonmark;
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
    })
    .use(preset)
    .use(variant === 'compat' ? gfmWithCompat() : gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(cursor)
    .use(trailing)
    .create();
  try {
    const view = editor.ctx.get(editorViewCtx);
    view.focus();
    const data = new DataTransfer();
    data.setData('text/plain', markdown);
    view.dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return editor.action(getMarkdown());
  } finally {
    await editor.destroy();
    root.remove();
  }
}

/**
 * Mounts an editor that STAYS mounted, with the caret focused between the first
 * two adjacent non-text inline nodes (two images), for a test that drives a real
 * IME into it. Returns a probe for `view.composing`. Positioning the caret is a
 * selection, not input: the composition itself is the test's CDP IME.
 */
async function mountForIme(
  variant: CensusVariant,
  markdown: string,
): Promise<{ composing: () => boolean; destroy: () => Promise<void> }> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const preset = variant === 'compat' ? commonmarkWithCompat() : commonmark;
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(preset)
    .use(variant === 'compat' ? gfmWithCompat() : gfm)
    .use(history)
    .use(listener)
    .use(clipboard)
    .use(cursor)
    .use(trailing)
    .create();
  editor.action(replaceAll(markdown));
  const view = editor.ctx.get(editorViewCtx);
  let gap = -1;
  view.state.doc.descendants((node, pos, parent, index) => {
    if (gap >= 0) return false;
    if (node.isInline && !node.isText && index > 0) {
      const before = parent?.child(index - 1);
      if (before?.isInline && !before.isText) gap = pos;
    }
    return true;
  });
  if (gap < 0) throw new Error('no two adjacent inline nodes in the fixture');
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(gap))));
  view.focus();
  return {
    composing: () => view.composing,
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

declare global {
  interface Window {
    __futoCensus: {
      load: (variant: CensusVariant, markdown: string) => Promise<RoundTrip>;
      headingEditChurn: (variant: CensusVariant, markdown: string) => Promise<HeadingEditChurn>;
      pastePlainText: (variant: CensusVariant, markdown: string) => Promise<string>;
      mountForIme: typeof mountForIme;
    };
  }
}

window.__futoCensus = { load: loadOnce, headingEditChurn, pastePlainText, mountForIme };
