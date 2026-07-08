import { describe, it, expect } from 'vitest';
import { loadSpecCases, getCasesDir } from './loader.js';
import { extractTags, extractHeaderTagBlock } from '@futo-notes/editor';

/**
 * Server-side conformance runner. Catches client/server drift —
 * the client uses CM6's syntax tree while the server uses regex.
 */

const maxComplexity = process.env.SPEC_MAX_COMPLEXITY
  ? parseInt(process.env.SPEC_MAX_COMPLEXITY)
  : undefined;

const allCases = loadSpecCases(getCasesDir(), maxComplexity);

const tagCases = allCases.filter((c) => c.expect?.tags !== undefined);
const headerBlockCases = allCases.filter((c) => c.expect?.header_tag_block !== undefined);

describe('Tag Extraction Conformance', () => {
  for (const specCase of tagCases) {
    it(`[${specCase.complexity}] ${specCase.name}`, () => {
      expect(extractTags(specCase.markdown)).toEqual(specCase.expect!.tags);
    });
  }
});

describe('Header Tag Block Conformance', () => {
  for (const specCase of headerBlockCases) {
    it(`[${specCase.complexity}] ${specCase.name}`, () => {
      const result = extractHeaderTagBlock(specCase.markdown);
      expect(result.tags).toEqual(specCase.expect!.header_tag_block!.tags);
      if (specCase.expect!.header_tag_block!.hidden) {
        expect(result.endOffset).toBeGreaterThan(0);
      } else {
        expect(result.endOffset).toBe(0);
      }
    });
  }
});
