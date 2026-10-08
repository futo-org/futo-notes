import { parserCtx, serializerCtx, SerializerReady } from '@milkdown/kit/core';
import type { Ctx, MilkdownPlugin } from '@milkdown/kit/ctx';

import { createMarkdownSerializer, type MarkdownSerializer, type NodeJson } from '../markdown';

/**
 * The editor's own markdown serializer (`../markdown`, #266) over THIS
 * editor's parser — the one that will read the bytes back, wikilinks and every
 * other plugin included, which is what its parse-decided escaping asks.
 * Stateless apart from a small memo, so two of them write the same bytes.
 *
 * The parser is looked up on every parse rather than captured: it does not
 * exist until `ParserReady`, and a serializer may be built before that.
 */
export function editorMarkdownSerializer(ctx: Ctx): MarkdownSerializer {
  return createMarkdownSerializer({
    parse: (markdown) => ctx.get(parserCtx)(markdown).toJSON() as NodeJson,
  });
}

/**
 * Makes the owned serializer Milkdown's `serializerCtx`, so the one serializer
 * in the product is also what `getMarkdown()` and the clipboard's text/plain
 * write. Milkdown's own remark-stringify serializer is built at
 * `SerializerReady` and replaced here before `create()` resolves; nothing calls
 * it after that.
 *
 * The app's save path does not read the ctx: it keeps a per-block cache over
 * {@link editorMarkdownSerializer} (src/features/editor/milkdown/
 * serializationLoop.ts), and `just chunk-census --serialize` proves the cache
 * and this whole-document serialization write the same bytes.
 */
export const ownedSerializerPlugin: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SerializerReady);
  const serializer = editorMarkdownSerializer(ctx);
  ctx.set(serializerCtx, (doc) => serializer.serialize(doc.toJSON() as NodeJson));
};
