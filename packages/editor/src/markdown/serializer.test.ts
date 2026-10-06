import { describe, expect, it } from 'vitest';

import { joinDocument, planDocument, type BlockSummary } from './serializer';

// The byte-level house style is locked by the goldens against the real parser
// (tests/conformance/markdown-house-style.json, run from
// src/features/editor/milkdown/markdownHouseStyle.test.ts). These pin the two
// cross-block rules the save cache relies on, which need no parser at all.

const block = (listKind: BlockSummary['listKind'] = null): BlockSummary => ({
  empty: false,
  listKind,
  references: [],
});
const empty: BlockSummary = { empty: true, listKind: null, references: [] };

describe('joinDocument', () => {
  it('separates blocks by a blank line, plus one per empty paragraph between them', () => {
    expect(joinDocument(['a', 'b'])).toBe('a\n\nb\n');
    expect(joinDocument(['a', null, null, 'b'])).toBe('a\n\n\n\nb\n');
  });

  it('keeps empty paragraphs before the first block and drops trailing ones', () => {
    expect(joinDocument([null, null, 'a', null])).toBe('\n\na\n');
  });

  it('writes nothing at all for a document of empty paragraphs', () => {
    expect(joinDocument([null, null])).toBe('');
    expect(joinDocument([])).toBe('');
  });
});

describe('planDocument', () => {
  it('alternates the marker of a list that touches one of the same kind', () => {
    const plan = planDocument([block('bullet'), block('bullet'), block('bullet')]);
    expect(plan.map((position) => position?.listMarker)).toEqual(['-', '*', '-']);
  });

  it('counts lists separated only by empty paragraphs as touching', () => {
    const plan = planDocument([block('ordered'), empty, empty, block('ordered')]);
    expect(plan.map((position) => position?.listMarker ?? null)).toEqual(['.', null, null, ')']);
  });

  it('starts over after any other block, and ignores a list of the other kind', () => {
    const plan = planDocument([block('bullet'), block(), block('bullet'), block('ordered')]);
    expect(plan.map((position) => position?.listMarker ?? null)).toEqual(['-', null, '-', '.']);
  });

  it('puts only a block with nothing before it on the first line', () => {
    expect(planDocument([block(), block()]).map((position) => position?.firstLine)).toEqual([
      true,
      false,
    ]);
    expect(planDocument([empty, block()])[1]?.firstLine).toBe(false);
  });
});
