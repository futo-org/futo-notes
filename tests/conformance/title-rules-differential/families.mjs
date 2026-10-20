/**
 * The family table: which corpus feeds which fixture and ops.
 */

import { imageFilenameCorpus } from './image-corpus.mjs';
import { previewCorpus } from './preview-corpus.mjs';
import { tagContentCorpus, tagNameCorpus } from './tags-corpus.mjs';
import { collisionCorpus, folderPathCorpus, titleCorpus } from './title-corpus.mjs';
import { rewriteCorpus, suffixCorpus, wikilinkTargetCorpus } from './wikilink-corpus.mjs';

// --- Family table -----------------------------------------------------------
//
// Adding a family: add an entry whose `probes()` yields `{ op, input }` for every
// op the family's fixture uses, then add each op to `TS_OPS` and to the Rust
// dispatcher. The coverage guard tells you if you missed one.

export const FAMILIES = [
  {
    name: 'title',
    fixture: 'filename',
    probes() {
      const titles = titleCorpus();
      const out = [];
      for (const op of [
        'sanitizeTitle',
        'validateTitle',
        'isValidTitle',
        'isWindowsReservedName',
        'validateFolderName',
        'isValidFolderName',
      ]) {
        for (const title of titles) out.push({ op, input: title });
      }
      for (const relPath of folderPathCorpus()) {
        out.push({ op: 'validateFolderPath', input: relPath });
        out.push({ op: 'isValidFolderPath', input: relPath });
        out.push({ op: 'pathDepth', input: relPath });
      }
      for (const input of collisionCorpus()) {
        out.push({ op: 'hasCaseInsensitiveSiblingCollision', input });
      }
      return out;
    },
  },
  {
    name: 'tags',
    fixture: 'tags',
    probes() {
      const out = [];
      for (const content of tagContentCorpus()) {
        out.push({ op: 'tagRegexMatches', input: content });
        out.push({ op: 'extractTags', input: content });
        out.push({ op: 'extractHeaderTagBlock', input: content });
      }
      for (const name of tagNameCorpus()) {
        out.push({ op: 'isValidTagName', input: name });
        out.push({ op: 'normalizeTagName', input: name });
      }
      return out;
    },
  },
  {
    name: 'image',
    fixture: 'image',
    probes() {
      const out = imageFilenameCorpus().map((filename) => ({
        op: 'isImageFilename',
        input: filename,
      }));
      out.push({ op: 'imageExtensions', input: null });
      return out;
    },
  },
  {
    name: 'preview',
    fixture: 'preview',
    probes() {
      return previewCorpus().map((content) => ({ op: 'makePreview', input: content }));
    },
  },
  {
    name: 'wikilinks',
    fixture: 'wikilinks-*',
    probes() {
      return [
        ...wikilinkTargetCorpus().map((input) => ({ op: 'resolveWikilink', input })),
        ...suffixCorpus().map((input) => ({ op: 'shortestUniqueSuffix', input })),
        ...rewriteCorpus().map((input) => ({ op: 'rewriteWikilinks', input })),
      ];
    },
  },
];
