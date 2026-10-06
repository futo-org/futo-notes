/**
 * The save cache over `./serializer.ts`: one written string per top-level
 * block, keyed on the block's identity, so a save costs what the edit touched.
 *
 * Generic over the block type so it holds no ProseMirror import: the app hands
 * it an adapter that lists a document's top-level blocks and turns one into
 * JSON. An unchanged block is the same object across transactions, so a
 * WeakMap hit costs nothing; a changed block is a new object and is summarized
 * and written once. Nothing mirrors an outside library's joining rules any
 * more — the serializer owns the separator (`join`) and the only
 * cross-block state, the list marker and the definitions (`planDocument`,
 * `references`), is recomputed from cached summaries on every call.
 */
import {
  planDocument,
  references,
  type BlockContext,
  type BlockSummary,
  type MarkdownSerializer,
  type WrittenBlock,
} from './serializer';
import type { NodeJson } from './docJson';

export interface DocumentAdapter<Block extends object, Doc = unknown> {
  /** The document's top-level blocks, in order. */
  children(doc: Doc): readonly Block[];
  /** One block as `toJSON()` — only called for a block the cache cannot answer. */
  toJSON(block: Block): NodeJson;
}

export interface CachedSerializer<Doc> {
  /** The whole document, byte-equal to `serializer.serialize(doc.toJSON())`. Fills misses synchronously. */
  serialize(doc: Doc): string;
  /** True when every block of `doc` is cached (serialize() would write nothing new). */
  isPrimed(doc: Doc): boolean;
  /** Writes uncached blocks while `timeRemainingMs()` > 0 (at least one per call). True when `doc` is primed. */
  prime(doc: Doc, timeRemainingMs: () => number): boolean;
}

interface Entry {
  readonly summary: BlockSummary;
  /** The block's JSON from the summary, kept only until its first write. */
  json: NodeJson | null;
  written: (WrittenBlock & { readonly context: BlockContext }) | null;
}

function fits(written: Entry['written'], context: BlockContext): boolean {
  return (
    written !== null &&
    written.context.listMarker === context.listMarker &&
    (!written.checked || written.context.references === context.references)
  );
}

export function createCachedSerializer<Block extends object, Doc>(
  serializer: MarkdownSerializer,
  adapter: DocumentAdapter<Block, Doc>,
): CachedSerializer<Doc> {
  const cache = new WeakMap<Block, Entry>();
  /** The last `references` string, reused while equal so the per-block test is a pointer compare. */
  let lastReferences = '';

  function entry(block: Block): Entry {
    let found = cache.get(block);
    if (!found) {
      const json = adapter.toJSON(block);
      const summary = serializer.summarize(json);
      // An empty paragraph is never written, so its JSON is never needed.
      found = { summary, json: summary.empty ? null : json, written: null };
      cache.set(block, found);
    }
    return found;
  }

  /** Every block with the context it is written in (null for an empty paragraph). */
  function layout(doc: Doc): { block: Block; entry: Entry; context: BlockContext | null }[] {
    const blocks = adapter.children(doc);
    const entries = blocks.map(entry);
    const summaries = entries.map((found) => found.summary);
    const refs = references(summaries);
    if (refs !== lastReferences) lastReferences = refs;
    const plan = planDocument(summaries);
    return blocks.map((block, index) => {
      const position = plan[index];
      const context = position ? { ...position, references: lastReferences } : null;
      return { block, entry: entries[index] as Entry, context };
    });
  }

  function written(block: Block, found: Entry, context: BlockContext): string {
    if (!fits(found.written, context)) {
      const json = found.json ?? adapter.toJSON(block);
      found.json = null;
      found.written = { ...serializer.serializeBlock(json, context), context };
    }
    return (found.written as WrittenBlock).text;
  }

  return {
    serialize(doc) {
      const rows = layout(doc);
      return serializer.join(
        rows.map(({ block, entry: found, context }) =>
          context ? written(block, found, context) : null,
        ),
        rows.map(({ entry: found }) => found.summary),
      );
    },
    isPrimed(doc) {
      return layout(doc).every(
        ({ entry: found, context }) => !context || fits(found.written, context),
      );
    },
    prime(doc, timeRemainingMs) {
      let didWork = false;
      for (const { block, entry: found, context } of layout(doc)) {
        if (!context || fits(found.written, context)) continue;
        if (didWork && timeRemainingMs() <= 0) return false;
        written(block, found, context);
        didWork = true;
      }
      return true;
    },
  };
}
