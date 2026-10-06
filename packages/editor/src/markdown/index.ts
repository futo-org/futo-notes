// The editor's own markdown serializer (#266) — see ./serializer.ts for the
// contract and the integration recipe, docs/spec/editor.md "Markdown house
// style" for what it writes.
export {
  createMarkdownSerializer,
  joinDocument,
  planDocument,
  references,
  summarizeBlock,
  type BlockContext,
  type BlockSummary,
  type ListMarker,
  type MarkdownSerializer,
  type MarkdownSerializerOptions,
  type WrittenBlock,
} from './serializer';
export { createCachedSerializer, type CachedSerializer, type DocumentAdapter } from './cache';
export { canonical, normalizeBlock } from './normalize';
export { UnknownNodeError, type MarkJson, type NodeJson, type ParseMarkdown } from './docJson';
