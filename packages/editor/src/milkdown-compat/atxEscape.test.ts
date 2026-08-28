import { describe, expect, it } from 'vitest';
// The module under test deliberately does NOT import this (see atxEscape.ts) —
// but the canary below has to measure the real serializer, so the test does,
// and the version is pinned in this package's own devDependencies. If it ever
// drifts from the one @milkdown/kit resolves, that is itself worth knowing.
import { toMarkdown } from 'mdast-util-to-markdown';

import { ATX_HASH_PATTERN, narrowAtxHashEscape, type UnsafePattern } from './atxEscape';
import { withNarrowedAtxHashEscape } from './stringifyHandlers';

/** A remark-stringify node handler, as much of one as these tests need. */
type StringifyHandler = (node: unknown, parent: unknown, state: never, info: never) => string;

/** A one-paragraph mdast tree whose only text is `value`. */
function paragraph(value: string) {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
}

function serialize(value: string, handlers?: Record<string, StringifyHandler>): string {
  // `as never`: this test builds mdast literals by hand rather than importing
  // the @types/mdast node unions, and toMarkdown's own handler type is richer
  // than the four fields the wrapper touches.
  return toMarkdown(paragraph(value) as never, { handlers: handlers as never });
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

describe('withNarrowedAtxHashEscape', () => {
  const patched = (value: string) =>
    serialize(value, {
      text: withNarrowedAtxHashEscape(
        (
          node: { value: string },
          _parent: unknown,
          // The stock text handler, so the test measures the escape and
          // nothing else.
          state: { unsafe: UnsafePattern[]; safe(value: string, config: object): string },
          info: object,
        ) => state.safe(node.value, info),
      ) as unknown as StringifyHandler,
    });

  it('keeps a leading tag intact, so the header tag block survives a save', () => {
    expect(patched('#alpha #beta')).toBe('#alpha #beta\n');
  });

  it.each([
    ['#5 on the list', '#5 on the list\n'],
    ['#######x', '#######x\n'],
    ['#tag-with-dashes', '#tag-with-dashes\n'],
  ])('leaves %j alone', (input, expected) => {
    expect(patched(input)).toBe(expected);
  });

  it.each([
    ['# Heading', '\\# Heading\n'],
    ['###### Six', '\\###### Six\n'],
    ['#\ttab', '\\#\ttab\n'],
    ['#', '\\#\n'],
  ])('still escapes %j, which CommonMark would read as a heading', (input, expected) => {
    expect(patched(input)).toBe(expected);
  });

  it('does not disturb any other escape', () => {
    expect(patched('* not a list')).toBe(serialize('* not a list'));
    expect(patched('1. not ordered')).toBe(serialize('1. not ordered'));
    expect(patched('> not a quote')).toBe(serialize('> not a quote'));
  });

  it('escapes a heading on a later line of the same text node', () => {
    // mdast keeps a hard break's two lines in separate text nodes, but a
    // handler must not assume its value is single-line.
    expect(patched('body\n# Heading')).toContain('\\# Heading');
    expect(patched('body\n#tag')).toContain('\n#tag');
  });
});
