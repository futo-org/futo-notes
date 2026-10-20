/**
 * The TypeScript side of every cross-language op the differential drives.
 */

import {
  hasCaseInsensitiveSiblingCollision,
  isValidFolderName,
  isValidFolderPath,
  isValidTitle,
  isWindowsReservedName,
  pathDepth,
  sanitizeTitle,
  validateFolderName,
  validateFolderPath,
  validateTitle,
} from '../../../packages/editor/src/filename.ts';
import { IMAGE_EXTENSIONS, isImageFilename } from '../../../packages/editor/src/images.ts';
import { makePreview } from '../../../packages/editor/src/preview.ts';
import {
  extractHeaderTagBlock,
  extractTags,
  isValidTagName,
  normalizeTagName,
  tagRegexMatches,
} from '../../../packages/editor/src/tags.ts';
import {
  resolveWikilink,
  rewriteWikilinks,
  shortestUniqueSuffix,
} from '../../../src/shared/note/wikilinks.ts';

// --- The TypeScript side of every cross-language op -------------------------
//
// Keys are the language-neutral verbs the fixtures use and the Rust dispatcher
// (`crates/futo-notes-model/tests/support/rule_ops.rs`) answers. Every value must
// return plain JSON - the comparison is structural, not by identity.

export const TS_OPS = {
  // filename.ts - titles
  sanitizeTitle: (input) => sanitizeTitle(input),
  validateTitle: (input) => validateTitle(input).map((issue) => issue.kind),
  isValidTitle: (input) => isValidTitle(input),
  isWindowsReservedName: (input) => isWindowsReservedName(input),
  // filename.ts - folders
  validateFolderName: (input) => validateFolderName(input).map((issue) => issue.kind),
  isValidFolderName: (input) => isValidFolderName(input),
  hasCaseInsensitiveSiblingCollision: (input) =>
    hasCaseInsensitiveSiblingCollision(input.name, input.siblings),
  validateFolderPath: (input) => validateFolderPath(input).map((issue) => issue.kind),
  isValidFolderPath: (input) => isValidFolderPath(input),
  pathDepth: (input) => pathDepth(input),
  // tags.ts
  tagRegexMatches: (input) => tagRegexMatches(input),
  isValidTagName: (input) => isValidTagName(input),
  normalizeTagName: (input) => normalizeTagName(input),
  extractTags: (input) => extractTags(input),
  extractHeaderTagBlock: (input) => {
    const { tags, endOffset } = extractHeaderTagBlock(input);
    return { tags, endOffset, remainder: input.slice(endOffset) };
  },
  // preview.ts
  makePreview: (input) => makePreview(input),
  // images.ts
  isImageFilename: (input) => isImageFilename(input),
  imageExtensions: () => [...IMAGE_EXTENSIONS],
  // wikilinks.ts
  resolveWikilink: (input) => resolveWikilink(input.target, input.allIds),
  shortestUniqueSuffix: (input) => shortestUniqueSuffix(input.targetId, input.allIds),
  rewriteWikilinks: (input) => rewriteWikilinks(input.text, input.oldId, input.newId, input.allIds),
};
