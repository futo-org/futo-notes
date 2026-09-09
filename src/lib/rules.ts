export {
  FALLBACK_TITLE,
  FORBIDDEN_CHARS_RE,
  MAX_FOLDER_DEPTH,
  MAX_TITLE_LENGTH,
  validateTitle,
  validateFolderName,
  hasCaseInsensitiveSiblingCollision,
  isValidTagName,
  normalizeTagName,
  extractTags,
  extractHeaderTagBlock,
  scanTags,
} from '@futo-notes/editor';
export { sanitizeTitle as sanitizeFilename } from '@futo-notes/editor';
export type { FilenameIssueKind } from '@futo-notes/editor';
