import { serializerCtx } from '@milkdown/kit/core';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { WHOLE as CENSUS_WHOLE } from './chunkCensusHook';
import type { DocumentLoad } from './documentLoad';
import type { DocumentSession } from './documentSession.svelte';
import { planMarkdownChunks, type MarkdownChunkOptions } from './markdownChunks';
import { createDocumentSerializer, type SerializationLoop } from './serializationLoop';
import type { HostHandleDeps } from './hostHandleDeps';

/** The census and gauntlet harnesses' doors (src/editor-embed/main.ts); no shell calls these. */
export function createHarnessProbes(
  session: DocumentSession,
  serialization: SerializationLoop,
  documentLoad: DocumentLoad,
  deps: HostHandleDeps,
) {
  const { getEditor, pmView } = deps;
  const { readSerialized } = serialization;
  const { applyExternal, endPendingLoad } = documentLoad;

  /**
   * Loads `text` with explicit chunk options and returns the editor's
   * serialization of the resulting document, plus the plan that produced it.
   *
   * The ONLY consumer is the chunk-equivalence census
   * (`scripts/milkdown-chunk-census.mjs`), which proves the claim progressive
   * open rests on: a chunked parse of a note produces the same document as a
   * whole-document parse of it. That comparison cannot go through the bridge,
   * because the bridge deliberately never hands out a serialization of an
   * unedited note — that IS the load-echo guard. `src/editor-embed/main.ts`
   * installs it only for `editor.html?census`, a URL no shell ever loads.
   *
   * Read-only with respect to the host: it never posts a message and never
   * touches `hostMarkdown` beyond what a normal load does.
   */
  function censusLoad(
    text: string,
    chunkOptions: MarkdownChunkOptions,
  ): { markdown: string | null; chunked: boolean; chunks: number; aborted: boolean } {
    const plan = planMarkdownChunks(text, chunkOptions);
    applyExternal(text, chunkOptions);
    endPendingLoad('settle');
    return {
      markdown: readSerialized(),
      chunked: plan.chunked,
      chunks: plan.chunks.length,
      aborted: session.abortedToWholeDocument,
    };
  }

  /**
   * Loads `text` as a whole document and reports the whole-document
   * serialization Milkdown's `serializerCtx` now holds (the owned serializer,
   * what `getMarkdown()` writes) next to a FRESH per-block cache's
   * serialization of the SAME document (`createDocumentSerializer`,
   * serializationLoop.ts) — the equivalence the block-serialization census
   * (`scripts/milkdown-chunk-census.mjs --serialize`) exists to measure.
   *
   * A fresh cache rather than the component's own, because the claim under
   * test is "the cache computes the same bytes as the direct call", and the
   * component's cache may already hold entries from whatever this instance
   * loaded before — reusing it would let a STALE cache entry pass unnoticed.
   * `whole` bypasses the cache entirely, so it is unaffected by any bug in it.
   *
   * Same door as `censusLoad`: read-only with respect to the host, never
   * posts a message, and installed only behind `editor.html?census`
   * (chunkCensusHook.ts).
   */
  function censusSerialize(text: string): { whole: string | null; blocks: string | null } {
    applyExternal(text, CENSUS_WHOLE);
    endPendingLoad('settle');
    const editor = getEditor();
    const view = pmView();
    if (!editor || !view) return { whole: null, blocks: null };
    try {
      const whole = editor.ctx.get(serializerCtx)(view.state.doc);
      return { whole, blocks: createDocumentSerializer(editor).serialize(view.state.doc) };
    } catch {
      return { whole: null, blocks: null };
    }
  }

  /**
   * The live ProseMirror view, for the editor gauntlet's Milkdown adapter
   * (tests/editor-gauntlet/milkdownAdapter.ts) — the permanent regression
   * suite, which drives the SAME editor.html bytes the shells ship and so has
   * no other way in.
   *
   * It exists because the gauntlet's two hardest jobs need the document model,
   * not the DOM: placing a caret at an exact position across 31k foreign notes,
   * and timing one keystroke's SYNCHRONOUS cost against the 16 ms budget. A
   * DOM-selection approximation would measure a different thing and quietly
   * change what the budget means.
   *
   * Read-only by intent and not part of the futoBridge contract; no native
   * host calls it. `main.ts` is what puts it on `window`.
   */
  function getProseMirrorView(): ProseView | null {
    return pmView();
  }

  return { censusLoad, censusSerialize, getProseMirrorView };
}
