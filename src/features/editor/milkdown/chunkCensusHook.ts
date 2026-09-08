/**
 * The chunk-equivalence census seam.
 *
 * Progressive open (docs/plan/milkdown-transition.md §5, issue #105) rests on
 * one claim: parsing a note in top-level chunks and appending them produces the
 * SAME ProseMirror document as parsing the whole string at once. That claim can
 * only be settled against the real editor over real notes, and the futoBridge
 * surface deliberately cannot answer it — `getContent()` hands back the host's
 * original bytes for an unedited note, which is the load-echo guard doing its
 * job (ADR-0002).
 *
 * So the census gets its own door: `editor.html?census` installs
 * `window.__futoChunkCensus`, and `scripts/milkdown-chunk-census.mjs` drives it.
 * No shell ever loads that URL — the native hosts open the bundle with no query
 * string, and the query string is already how the bundle picks its engine
 * (`?cm`). The hook is read-only: it loads markdown and reports the
 * serialization, posts no bridge message, and touches nothing a host owns.
 *
 * It lives here rather than in `src/editor-embed/` because that directory is
 * the native web-editor BOUNDARY and implements the versioned `futoBridge`
 * contract (src/AGENTS.md), and this is emphatically not the bridge — it is a
 * test seam onto the progressive-open modules beside it. `main.ts` only decides
 * whether to install it.
 */

import type { MarkdownChunkOptions } from './markdownChunks';

/** What the census learns about one note. */
export interface ChunkCensusResult {
  /** Milkdown's serialization after a whole-document parse. */
  whole: string | null;
  /** Milkdown's serialization after a chunked parse of the same note. */
  chunked: string | null;
  /** False when the planner declined to chunk this note (see the reasons). */
  wasChunked: boolean;
  /** How many chunks the plan produced. */
  chunks: number;
  /**
   * True when the loader gave up on chunking mid-flight and reloaded the note
   * whole. Such a note proves NOTHING about equivalence — its `chunked`
   * serialization came from a whole-document parse — so the census counts it
   * separately rather than as a match.
   */
  aborted: boolean;
}

/** The subset of the editor handle this hook needs. */
export interface ChunkCensusEditor {
  censusLoad?: (
    text: string,
    chunkOptions: MarkdownChunkOptions,
  ) => { markdown: string | null; chunked: boolean; chunks: number; aborted: boolean };
  /** See `SerializeCensusResult` below. */
  censusSerialize?: (text: string) => SerializeCensusResult;
}

export interface ChunkCensusWindow {
  __futoChunkCensus?: (markdown: string) => ChunkCensusResult;
  __futoSerializeCensus?: (markdown: string) => SerializeCensusResult;
}

/**
 * Forces a whole-document parse: no document has an infinite number of lines.
 * Exported so `MilkdownEditor.svelte`'s `censusSerialize` can force the same
 * whole-document load without a second, drifting definition of "whole".
 */
export const WHOLE: MarkdownChunkOptions = { minLines: Number.POSITIVE_INFINITY };
/* Forces the chunked path, at the finest granularity the planner will allow —
 * the census wants the MOST cut points, because every one of them is a place
 * the two parses could disagree. */
const CHUNKED: MarkdownChunkOptions = { minLines: 0, firstChunkLines: 1, chunkLines: 1 };

/** What the block-serializer-equivalence census learns about one note. */
export interface SerializeCensusResult {
  /** Milkdown's OWN serializer, called directly on the whole loaded document. */
  whole: string | null;
  /** A FRESH `BlockSerializer`'s `serialize()` of the same document. */
  blocks: string | null;
}

export function installChunkCensusHook(editor: ChunkCensusEditor): void {
  (window as unknown as ChunkCensusWindow).__futoChunkCensus = (markdown: string) => {
    if (!editor.censusLoad) {
      throw new Error('editor.html?census: this engine has no censusLoad (is it the ?cm engine?)');
    }
    const whole = editor.censusLoad(markdown, WHOLE);
    const chunked = editor.censusLoad(markdown, CHUNKED);
    return {
      whole: whole.markdown,
      chunked: chunked.markdown,
      wasChunked: chunked.chunked,
      chunks: chunked.chunks,
      aborted: chunked.aborted,
    };
  };
  (window as unknown as ChunkCensusWindow).__futoSerializeCensus = (markdown: string) => {
    if (!editor.censusSerialize) {
      throw new Error(
        'editor.html?census: this engine has no censusSerialize (is it the ?cm engine?)',
      );
    }
    return editor.censusSerialize(markdown);
  };
}
