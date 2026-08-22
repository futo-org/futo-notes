// Canonical TypeScript copy of the note-preview rule.
//
// This is the SAME rule implemented in Rust (`futo-notes-model::make_preview`,
// crates/futo-notes-model/src/crud.rs). The conformance harness
// (tests/conformance/preview.json, crates/futo-notes-model/tests/conformance.rs,
// ./conformance.test.ts) keeps the two bit-for-bit identical, so the
// optimistic-cache hot path (src/features/notes/notesIndex.ts) produces the EXACT same
// sidebar preview before a rescan/sync as the Rust scan does after.
//
// It lives here — in the web/presentation layer — because the reactive note
// state needs it synchronously (optimistic cache updates); routing it through
// Tauri IPC would add a round-trip on the list hot path.

/** Max preview length in Unicode scalar values (code points), matching Rust. */
export const PREVIEW_MAX_CHARS = 100;

/**
 * Stands in for an embedded image in every list preview. Two code points
 * (U+1F5BC framed picture + U+FE0F variation selector), so it spends two of the
 * preview budget and renders as an emoji rather than a text glyph.
 *
 * MUST equal Rust `futo_notes_model::IMAGE_PLACEHOLDER`.
 */
export const IMAGE_PLACEHOLDER = '\u{1F5BC}\u{FE0F}';

/**
 * A markdown image construct: `![alt](target)`.
 *
 * A non-`]` alt run, then a non-`)` target run — the same scan Rust's
 * `image_construct_end` performs. A construct missing either terminator is left
 * alone, and `[link](url)` without the leading `!` is not an image.
 */
const IMAGE_MARKDOWN_PATTERN = /!\[[^\]]*\]\([^)]*\)/gu;

/**
 * ~100-char preview: image markdown stood in as an emoji placeholder, CR/LF/TAB
 * collapsed to single spaces, then trimmed.
 *
 * MUST match Rust `make_preview` exactly:
 *   0. Replace every `![alt](target)` image construct with
 *      `IMAGE_PLACEHOLDER`. Previews are read as text, so raw image markdown is
 *      noise — a note starting with an image previewed as
 *      `![](image-20260814-130425.png)`.
 *   1. Replace `\r\n`, then bare `\n`, then `\t` with a single space each.
 *      (`\r\n` is collapsed first so a CRLF becomes ONE space, not two. A bare
 *      `\r` not followed by `\n` is intentionally left as-is — Rust does the
 *      same.)
 *   2. Trim leading/trailing whitespace.
 *   3. Take the first 100 *code points* (`Array.from`, like Rust's
 *      `.chars().take(100)`), NOT UTF-16 units — so astral characters like
 *      emoji are never split mid-pair.
 *
 * Note the order: collapse + trim happen BEFORE truncation, so the 100-char
 * budget is spent on visible content, not on whitespace that gets dropped.
 */
export function makePreview(content: string): string {
  const collapsed = content
    .replace(IMAGE_MARKDOWN_PATTERN, IMAGE_PLACEHOLDER)
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ');
  const trimmed = collapsed.trim();
  return Array.from(trimmed).slice(0, PREVIEW_MAX_CHARS).join('');
}
