/**
 * Single import seam for the deterministic note rules (filename/title + tags)
 * used across the Svelte app. Re-exports the canonical TypeScript copy from
 * `@futo-notes/editor`, which is kept bit-for-bit identical to the Rust
 * `futo-notes-model` rules by the conformance harness.
 *
 * Why a shim (migration plan, Phase 3): the reactive layer (`notes.svelte.ts`,
 * `notesIndex.ts`, `folders.svelte.ts`, `noteSession.svelte.ts`, the editor)
 * calls these rules SYNCHRONOUSLY — many per keystroke. They must NOT become
 * Tauri IPC round-trips. The Rust rules are still exposed as `#[tauri::command]`
 * wrappers (see `apps/tauri/src-tauri/src/rules.rs` → `bindings.ts`) for
 * non-hot-path / cross-platform use; this shim is the hot-path TS home and the
 * one place to swap an individual rule onto a command later if it's ever cheap
 * enough to do so.
 */
export {
  // filename / title
  FORBIDDEN_CHARS_RE,
  FORBIDDEN_CHARS_DISPLAY,
  MAX_TITLE_LENGTH,
  MAX_FOLDER_DEPTH,
  FALLBACK_TITLE,
  REPLACEMENT_CHAR,
  sanitizeTitle,
  validateTitle,
  isValidTitle,
  isWindowsReservedName,
  validateFolderName,
  isValidFolderName,
  hasCaseInsensitiveSiblingCollision,
  validateFolderPath,
  isValidFolderPath,
  pathDepth,
  // tags
  TAG_REGEX,
  MAX_TAG_LENGTH,
  isValidTagName,
  normalizeTagName,
  extractTags,
  extractHeaderTagBlock,
} from '@futo-notes/editor';
export type { FilenameIssue, FilenameIssueKind } from '@futo-notes/editor';
