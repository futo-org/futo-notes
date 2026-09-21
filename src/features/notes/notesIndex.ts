import { extractTags } from '$lib/rules';

/**
 * Canonical list-level tag names for a note — lowercase, WITHOUT the leading
 * `#`. Mirrors the Rust `futo-notes-model::note_tags` (and the `NoteMeta.tags`
 * the local-note store returns), so committed cache updates produce the
 * same tag shape as a Rust scan. `extractTags` returns `#tag`; strip it.
 */
export function noteTags(content: string): string[] {
  return extractTags(content).map((t) => t.replace(/^#/, ''));
}
