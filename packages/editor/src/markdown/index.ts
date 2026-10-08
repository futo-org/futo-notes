// The editor's own markdown serializer (#266) — see ./serializer.ts for the
// contract, docs/spec/editor.md "Markdown house style" for what it writes.
// Only what the app imports: the serializer, its per-block save cache, and
// the document shape both take.
export { createMarkdownSerializer, type MarkdownSerializer } from './serializer';
export { createCachedSerializer, type CachedSerializer } from './cache';
export type { NodeJson } from './docJson';
