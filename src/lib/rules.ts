/**
 * Single import seam for the deterministic note rules (filename/title + tags)
 * used across the Svelte app. Re-exports the canonical TypeScript copy from
 * `@futo-notes/editor`, which is kept bit-for-bit identical to the Rust
 * `futo-notes-model` rules by the conformance harness.
 *
 * Why a shim: the reactive layer (`notes.svelte.ts`,
 * `notesIndex.ts`, `folders.svelte.ts`, `noteSession.svelte.ts`, the editor)
 * calls these rules SYNCHRONOUSLY — many per keystroke. They must NOT become
 * Tauri IPC round-trips. This shim is the hot-path TS home and the one place
 * to keep the conformance-locked TS copy aligned with the Rust model.
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
  scanTags,
  tagRegexMatches,
} from '@futo-notes/editor';
export type { FilenameIssue, FilenameIssueKind, TagMatch } from '@futo-notes/editor';
