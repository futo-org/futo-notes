import { describe, expect, it } from 'vitest';
import type { SpecCase } from './schema.js';
import { partitionMarkdownSpecCases } from './batching.js';
import { getCasesDir, loadSpecCases } from './loader.js';

function specCase(overrides: Partial<SpecCase>): SpecCase {
  return {
    name: 'case',
    complexity: 10,
    markdown: 'text',
    cursor: null,
    expect: { visible_text: 'text' },
    ...overrides,
  };
}

describe('partitionMarkdownSpecCases', () => {
  it('batches only blurred static cases and preserves their order', () => {
    const blurred = Array.from({ length: 5 }, (_, index) => specCase({ name: `blurred-${index}` }));
    const cursor = specCase({ name: 'cursor', cursor: { line: 0, ch: 0 } });
    const movement = specCase({
      name: 'movement',
      cursor: undefined,
      start_cursor: { line: 0, ch: 0 },
      moves: ['ArrowRight'],
      expect: undefined,
      expect_final: { line: 0, ch: 1 },
    });

    const result = partitionMarkdownSpecCases([...blurred, cursor, movement], 2);

    expect(result.staticBlurBatches.map((batch) => batch.map(({ name }) => name))).toEqual([
      ['blurred-0', 'blurred-1'],
      ['blurred-2', 'blurred-3'],
      ['blurred-4'],
    ]);
    expect(result.isolatedCases.map(({ name }) => name)).toEqual(['cursor', 'movement']);
  });

  it('rejects an invalid batch size', () => {
    expect(() => partitionMarkdownSpecCases([], 0)).toThrow('positive integer');
  });

  it('routes every real corpus case exactly once and isolates all movement cases', () => {
    const cases = loadSpecCases(getCasesDir()).filter(
      (candidate) =>
        candidate.moves?.length ||
        candidate.expect?.decorations ||
        candidate.expect?.visible_text !== undefined ||
        candidate.expect?.visible_text_contains ||
        candidate.expect?.visible_text_excludes ||
        candidate.expect?.widgets,
    );

    const result = partitionMarkdownSpecCases(cases);
    const routed = [...result.staticBlurBatches.flat(), ...result.isolatedCases];

    expect(routed).toHaveLength(cases.length);
    expect(new Set(routed)).toEqual(new Set(cases));
    expect(result.isolatedCases.filter((candidate) => candidate.moves?.length)).toEqual(
      cases.filter((candidate) => candidate.moves?.length),
    );
  });
});
