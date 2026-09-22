import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { describe, expect, it } from 'vitest';

import { testSchema as s } from '../__fixtures__/schema';
import {
  createFindMatchReport,
  docTextSegments,
  findCurrentMatchIndex,
  findDocMatches,
  foldCase,
  wrapFindMatchIndex,
} from './findMatches';

function para(...content: ProseNode[]): ProseNode {
  return s.nodes.paragraph.create(null, content);
}

function doc(...blocks: ProseNode[]): ProseNode {
  return s.nodes.doc.create(null, blocks);
}

/** Each match as the text it covers, so a test reads like the document. */
function covered(node: ProseNode, query: string): string[] {
  return findDocMatches(node, query).map((match) => node.textBetween(match.from, match.to));
}

describe('foldCase', () => {
  it('lowercases ordinary text', () => {
    expect(foldCase('CaT')).toBe('cat');
  });

  // 'İ' lowercases to two code units, which would shift every offset after it.
  it('leaves a character whose lowercase is longer exactly as it was', () => {
    const grows = 'İ';
    expect(grows.toLowerCase().length).toBe(2);
    expect(foldCase(`a${grows}b`)).toBe(`a${grows}b`);
    expect(foldCase(`a${grows}b`)).toHaveLength(3);
  });
});

describe('docTextSegments', () => {
  it('joins text split only by a mark into one run', () => {
    const node = doc(para(s.text('bo', [s.marks.strong.create()]), s.text('ld')));
    expect(docTextSegments(node)).toEqual([{ from: 1, text: 'bold' }]);
  });

  it('ends a run at a block boundary', () => {
    const node = doc(para(s.text('one')), para(s.text('two')));
    expect(docTextSegments(node)).toEqual([
      { from: 1, text: 'one' },
      { from: 6, text: 'two' },
    ]);
  });

  it('ends a run at an inline leaf', () => {
    const node = doc(para(s.text('a'), s.nodes.hardbreak.create(), s.text('b')));
    expect(docTextSegments(node)).toEqual([
      { from: 1, text: 'a' },
      { from: 3, text: 'b' },
    ]);
  });
});

describe('findDocMatches', () => {
  it('matches case-insensitively and literally', () => {
    const node = doc(para(s.text('cat dog CAT concatenate')));
    expect(covered(node, 'cat')).toEqual(['cat', 'CAT', 'cat']);
  });

  it('reports positions a document slice can be taken at', () => {
    const node = doc(para(s.text('one')), para(s.text('one')));
    expect(findDocMatches(node, 'one')).toEqual([
      { from: 1, to: 4 },
      { from: 6, to: 9 },
    ]);
  });

  it('matches across a mark boundary', () => {
    const node = doc(para(s.text('bo', [s.marks.strong.create()]), s.text('ld')));
    expect(covered(node, 'bold')).toEqual(['bold']);
  });

  it('never matches across a block boundary', () => {
    const node = doc(para(s.text('foo')), para(s.text('bar')));
    expect(findDocMatches(node, 'foobar')).toEqual([]);
  });

  it('finds text inside a fenced code block', () => {
    const node = doc(s.nodes.code_block.create(null, s.text('let cat = 1')));
    expect(covered(node, 'cat')).toEqual(['cat']);
  });

  it('is empty for an empty query', () => {
    expect(findDocMatches(doc(para(s.text('anything'))), '')).toEqual([]);
  });

  it('does not report overlapping occurrences twice', () => {
    const node = doc(para(s.text('aaaa')));
    expect(findDocMatches(node, 'aa')).toEqual([
      { from: 1, to: 3 },
      { from: 3, to: 5 },
    ]);
  });

  // The trailing space is part of the literal (docs/spec/editor.md).
  it('honours a trailing space in the query', () => {
    const node = doc(para(s.text('Aug and August')));
    expect(findDocMatches(node, 'Aug ')).toEqual([{ from: 1, to: 5 }]);
  });
});

describe('findCurrentMatchIndex', () => {
  const matches = [
    { from: 2, to: 5 },
    { from: 10, to: 13 },
  ];

  it('prefers the match the selection exactly covers', () => {
    expect(findCurrentMatchIndex(matches, { from: 10, to: 13 })).toBe(1);
  });

  it('otherwise takes the first match at or after the selection', () => {
    expect(findCurrentMatchIndex(matches, { from: 6, to: 6 })).toBe(1);
  });

  it('wraps to the first match past the last one', () => {
    expect(findCurrentMatchIndex(matches, { from: 99, to: 99 })).toBe(0);
  });

  it('is -1 with no matches', () => {
    expect(findCurrentMatchIndex([], { from: 0, to: 0 })).toBe(-1);
  });
});

describe('wrapFindMatchIndex', () => {
  it('wraps both ways', () => {
    expect(wrapFindMatchIndex(3, 3)).toBe(0);
    expect(wrapFindMatchIndex(-1, 3)).toBe(2);
  });

  it('is -1 for an empty list', () => {
    expect(wrapFindMatchIndex(0, 0)).toBe(-1);
  });
});

describe('createFindMatchReport', () => {
  it('is one-based and worded by the engine', () => {
    expect(createFindMatchReport('cat', 0, 3)).toEqual({
      query: 'cat',
      current: 1,
      total: 3,
      label: '1 of 3',
    });
  });

  it('reports zero without a position', () => {
    expect(createFindMatchReport('zzz', -1, 0)).toEqual({
      query: 'zzz',
      current: 0,
      total: 0,
      label: '0',
    });
  });
});
