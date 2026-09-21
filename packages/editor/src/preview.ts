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
 * A `<br>`-family tag: `<br`, spaces/tabs, an optional `/`, spaces/tabs, `>`.
 *
 * These reach the vault on their own. Markdown cannot represent an empty
 * paragraph, so `@milkdown/preset-commonmark`'s serializer parks a placeholder
 * tag in the file for every blank line the author typed (its parse-side half is
 * `./milkdown-compat/emptyLine.ts`) — and a preview that showed it read
 * `<br /> Some text` in the note list. An author's own `<br>`, the standard way
 * to break a line inside a GFM table cell, reads as a space in preview text
 * too, so both are covered by the same replacement.
 *
 * Deliberately NOT a general HTML-tag strip: `<kbd>K</kbd>` and
 * `<!-- comment -->` still show, because a rule that eats anything between
 * angle brackets also eats `a <b` in prose. `[ \t]` rather than `\s`, and Rust
 * `skip_tag_spacing` matches exactly that — a Unicode-whitespace class would be
 * one more thing for the two sides to define identically.
 */
const LINE_BREAK_TAG_PATTERN = /<br[ \t]*\/?[ \t]*>/giu;

/**
 * ~100-char preview: image markdown stood in as an emoji placeholder, CR/LF/TAB
 * collapsed to single spaces, then trimmed.
 *
 * MUST match Rust `make_preview` exactly:
 *   0. Replace every `![alt](target)` image construct with
 *      `IMAGE_PLACEHOLDER`. Previews are read as text, so raw image markdown is
 *      noise — a note starting with an image previewed as
 *      `![](image-20260814-130425.png)`.
 *   0b. Replace every `<br>`-family tag with a single space, then let step 1's
 *      collapse and step 2's trim deal with the result — a line that was
 *      nothing but the editor's empty-paragraph placeholder disappears
 *      entirely. See `LINE_BREAK_TAG_PATTERN`.
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
    .replace(LINE_BREAK_TAG_PATTERN, ' ')
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ');
  const trimmed = collapsed.trim();
  return Array.from(trimmed).slice(0, PREVIEW_MAX_CHARS).join('');
}
