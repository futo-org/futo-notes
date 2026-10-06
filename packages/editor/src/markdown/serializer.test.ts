import { expect, it } from 'vitest';

import { joinDocument } from './serializer';

// Everything else about joining blocks (blank lines, empty paragraphs, list
// marker alternation, the first-line rule) is pinned byte for byte by the goldens
// (tests/conformance/markdown-house-style.json, run from
// src/features/editor/milkdown/markdownHouseStyle.test.ts). A document of only
// empty paragraphs is the one shape they do not reach.
it('writes nothing at all for a document of empty paragraphs', () => {
  expect(joinDocument([null, null])).toBe('');
  expect(joinDocument([])).toBe('');
});
