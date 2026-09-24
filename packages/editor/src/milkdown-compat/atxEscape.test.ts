import { describe, expect, it } from 'vitest';
// The module under test deliberately does NOT import this (see atxEscape.ts) —
// but the canary below has to measure the real serializer, so the test does,
// and the version is pinned in this package's own devDependencies. If it ever
// drifts from the one @milkdown/kit resolves, that is itself worth knowing.
import { toMarkdown } from 'mdast-util-to-markdown';

import { ATX_HASH_PATTERN, narrowAtxHashEscape, type UnsafePattern } from './atxEscape';

/** A one-paragraph mdast tree whose only text is `value`. */
function paragraph(value: string) {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
}

/** What the stock, unpatched serializer writes for `value`. */
function serialize(value: string): string {
  // `as never`: this test builds mdast literals by hand rather than importing
  // the @types/mdast node unions.
  return toMarkdown(paragraph(value) as never);
}

describe('the upstream bug this compat fix exists for (canary)', () => {
  /*
   * These lock the UNPATCHED behavior of the pinned mdast-util-to-markdown.
   * When upstream narrows its own rule these go red — and that is the signal
   * to delete `atxEscape.ts`, not to relax the test.
   * Reported upstream: syntax-tree/mdast-util-to-markdown.
   */
  it('escapes a line-leading `#` that cannot start a heading', () => {
    expect(serialize('#alpha #beta')).toBe('\\#alpha #beta\n');
  });

  it('escapes it even when six or more hashes rule out a heading', () => {
    expect(serialize('#######x')).toBe('\\#######x\n');
  });

  it('leaves a `#` alone in the middle of a line', () => {
    expect(serialize('some #project work')).toBe('some #project work\n');
  });
});

describe('narrowAtxHashEscape', () => {
  it('replaces the blanket line-leading `#` rule with the precise one', () => {
    const narrowed = narrowAtxHashEscape([{ atBreak: true, character: '#' }]);
    expect(narrowed).toEqual([ATX_HASH_PATTERN]);
  });

  it('leaves the heading-internal `#` rule alone', () => {
    const other: UnsafePattern = { character: '#', after: '(?:[\\r\\n]|$)' };
    expect(narrowAtxHashEscape([other])[0]).toBe(other);
  });

  it('leaves every other character alone, by reference', () => {
    const patterns: UnsafePattern[] = [
      { atBreak: true, character: '-' },
      { character: '&', after: '[#A-Za-z]' },
    ];
    expect(narrowAtxHashEscape(patterns)).toEqual(patterns);
    expect(narrowAtxHashEscape(patterns)[0]).toBe(patterns[0]);
  });
});
