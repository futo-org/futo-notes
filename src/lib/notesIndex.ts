import { extractTags } from '$lib/rules';
// `makePreview` is the canonical preview rule, single-sourced in the editor
// package and kept bit-for-bit identical to Rust `make_preview` by the
// conformance harness (tests/conformance/preview.json). It is re-exported here
// so existing `import { makePreview } from "./notesIndex"` call sites and the
// notesIndex test keep working.
import { makePreview } from '@futo-notes/editor';

// ── Preview ───────────────────────────────────────────────────────────

// `makePreview` is re-exported from the canonical editor-package rule (single
// source, kept identical to Rust `make_preview` by the conformance harness).
// Re-exporting preserves the `import { makePreview } from "./notesIndex"` API
// used by callers/tests.
export { makePreview };

/**
 * Canonical list-level tag names for a note — lowercase, WITHOUT the leading
 * `#`. Mirrors the Rust `futo-notes-model::note_tags` (and the `NoteMeta.tags`
 * the local-note store returns), so committed cache updates produce the
 * same tag shape as a Rust scan. `extractTags` returns `#tag`; strip it.
 */
export function noteTags(content: string): string[] {
  return extractTags(content).map((t) => t.replace(/^#/, ''));
}
