// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeBlockMove, applyBlockMove } from './blockHandle';

function move(
  doc: string,
  source: [number, number],
  target: [number, number],
  side: 'before' | 'after'
): string {
  const result = computeBlockMove(
    doc,
    { from: source[0], to: source[1] },
    { from: target[0], to: target[1] },
    side
  );
  if (!result) throw new Error('move was invalid');
  return applyBlockMove(doc, result.changes);
}

describe('computeBlockMove', () => {
  it('moves first paragraph after second', () => {
    const doc = 'alpha\n\nbeta\n\ngamma';
    // Block ranges for each paragraph
    const alpha: [number, number] = [0, 5];
    const beta: [number, number] = [7, 11];
    const result = move(doc, alpha, beta, 'after');
    expect(result).toBe('beta\n\nalpha\n\ngamma');
  });

  it('moves last paragraph before first', () => {
    const doc = 'alpha\n\nbeta\n\ngamma';
    const alpha: [number, number] = [0, 5];
    const gamma: [number, number] = [13, 18];
    const result = move(doc, gamma, alpha, 'before');
    expect(result).toBe('gamma\n\nalpha\n\nbeta');
  });

  it('refuses to move a block onto itself', () => {
    const doc = 'alpha\n\nbeta';
    const alpha = { from: 0, to: 5 };
    expect(computeBlockMove(doc, alpha, alpha, 'before')).toBeNull();
  });

  it('refuses when source overlaps target', () => {
    const doc = 'alpha\n\nbeta';
    expect(
      computeBlockMove(doc, { from: 0, to: 11 }, { from: 0, to: 5 }, 'after')
    ).toBeNull();
  });

  it('moves a heading after a paragraph', () => {
    // "# Title\n\nSome paragraph\n\n## Subtitle"
    const doc = '# Title\n\nSome paragraph\n\n## Subtitle';
    const heading: [number, number] = [0, 7]; // "# Title"
    const paragraph: [number, number] = [9, 23]; // "Some paragraph"
    const result = move(doc, heading, paragraph, 'after');
    expect(result).toBe('Some paragraph\n\n# Title\n\n## Subtitle');
  });

  it('keeps a single trailing newline at the inserted position', () => {
    const doc = 'one\n\ntwo';
    const one: [number, number] = [0, 3];
    const two: [number, number] = [5, 8];
    const result = move(doc, one, two, 'after');
    // Expect "two" first, followed by a separator, then "one"
    expect(result.trim()).toBe('two\n\none');
  });

  it('preserves single-newline style when moving a heading between paragraphs', () => {
    // heading\ntext\ngoes here — single newlines throughout
    const doc = '## a heading\ntext\ngoes here';
    const heading: [number, number] = [0, 12]; // "## a heading"
    const text: [number, number] = [13, 17];   // "text"
    const result = move(doc, heading, text, 'after');
    // Should NOT add blank lines — preserve single-newline style
    expect(result).toBe('text\n## a heading\ngoes here');
  });

  it('preserves double-newline style when doc uses blank lines', () => {
    const doc = '## heading\n\ntext\n\ngoes here';
    const heading: [number, number] = [0, 10];
    const text: [number, number] = [12, 16];
    const result = move(doc, heading, text, 'after');
    expect(result).toBe('text\n\n## heading\n\ngoes here');
  });
});
