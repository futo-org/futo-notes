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
 * ~100-char preview with CR/LF/TAB collapsed to single spaces and trimmed.
 *
 * MUST match Rust `make_preview` exactly:
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
  const collapsed = content.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\t/g, ' ');
  const trimmed = collapsed.trim();
  return Array.from(trimmed).slice(0, PREVIEW_MAX_CHARS).join('');
}
