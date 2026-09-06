import { describe, expect, it } from 'vitest';
// See atxEscape.test.ts for why these tests, and not the module, import the
// serializer: the canaries have to measure the pinned upstream behavior. The
// parser is here for the round-trip property, and pinned the same way.
import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';

import type { UnsafePattern } from './atxEscape';
import {
  withNarrowedEscapes,
  type TextHandlerInfo,
  type TextHandlerState,
} from './stringifyHandlers';
import { escapeDelimiterUnderscores, withoutPhrasingUnderscoreEscape } from './underscoreEscape';

type StringifyHandler = (node: unknown, parent: unknown, state: never, info: never) => string;

function paragraph(value: string) {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
}

function serialize(value: string, handlers?: Record<string, StringifyHandler>): string {
  return toMarkdown(paragraph(value) as never, { handlers: handlers as never });
}

/** The stock `text` handler under the wrapper — so a test measures the escapes and nothing else. */
const narrowedText = withNarrowedEscapes(
  (
    node: { value: string },
    _parent: unknown,
    state: TextHandlerState & { safe(value: string, config: object): string },
    info: TextHandlerInfo,
  ) => state.safe(node.value, info),
) as unknown as StringifyHandler;

const patched = (value: string) => serialize(value, { text: narrowedText });

describe('the upstream bug this compat fix exists for (canary)', () => {
  /*
   * These lock the UNPATCHED behavior of the pinned mdast-util-to-markdown.
   * When upstream narrows its own rule these go red — and that is the signal
   * to delete `underscoreEscape.ts`, not to relax the test.
   */
  it('escapes an underscore that sits inside a word', () => {
    expect(serialize('snake_case_word')).toBe('snake\\_case\\_word\n');
  });

  it('escapes the underscore inside a tag, which stops it being a tag', () => {
    expect(serialize('a #dog_problems tag')).toBe('a #dog\\_problems tag\n');
  });
});

describe('withoutPhrasingUnderscoreEscape', () => {
  it('drops the blanket phrasing `_` rule and nothing else, by reference', () => {
    const blanket: UnsafePattern = { character: '_', inConstruct: 'phrasing' };
    const atBreak: UnsafePattern = { atBreak: true, character: '_' };
    const star: UnsafePattern = { character: '*', inConstruct: 'phrasing' };
    const kept = withoutPhrasingUnderscoreEscape([atBreak, blanket, star]);
    expect(kept).toEqual([atBreak, star]);
    expect(kept[0]).toBe(atBreak);
  });
});

describe('escapeDelimiterUnderscores', () => {
  it.each(['snake_case_word', '#dog_problems', 'x_1 and y_2', 'file_name.txt'])(
    'leaves the intra-word underscores of %j alone',
    (input) => {
      expect(escapeDelimiterUnderscores(input, ' ', ' ')).toBe(input);
    },
  );

  it.each([
    ['_em_', '\\_em\\_'],
    ['a _b_ c', 'a \\_b\\_ c'],
    ['trailing_', 'trailing\\_'],
    ['(_paren_)', '(\\_paren\\_)'],
    ['word _ alone', 'word \\_ alone'],
  ])('escapes every `_` of %j that could open or close emphasis', (input, expected) => {
    expect(escapeDelimiterUnderscores(input, ' ', ' ')).toBe(expected);
  });

  it('decides each underscore of a run on its own, so a run comes out fully escaped', () => {
    // The two-pattern version left `____` as `\__\__` on one save and `\____`
    // on the next, and `__init__` as `\__init_\_` — which is emphasis.
    expect(escapeDelimiterUnderscores('____', ' ', '.')).toBe('\\_\\_\\_\\_');
    expect(escapeDelimiterUnderscores('__init__', ' ', ' ')).toBe('\\_\\_init\\_\\_');
    expect(escapeDelimiterUnderscores('an __id_ field', ' ', ' ')).toBe('an \\_\\_id\\_ field');
    expect(escapeDelimiterUnderscores('x__y', ' ', ' ')).toBe('x\\_\\_y');
  });

  it('judges an edge underscore against the neighbour outside the node', () => {
    // `**bold**_x`: the text node is `_x`, and the character before it is `*`.
    expect(escapeDelimiterUnderscores('_x', '*', ' ')).toBe('\\_x');
    // `foo_` followed by `**bold**`: the `*` after it is not a word character.
    expect(escapeDelimiterUnderscores('foo_', ' ', '*')).toBe('foo\\_');
    // ...but a node boundary inside a word (a mark ends mid-word) is intra-word.
    expect(escapeDelimiterUnderscores('_bar', 'o', ' ')).toBe('_bar');
    expect(escapeDelimiterUnderscores('foo_', ' ', 'b')).toBe('foo_');
  });

  it('is conservative about non-ASCII letters, like stock remark', () => {
    expect(escapeDelimiterUnderscores('café_bar', ' ', ' ')).toBe('café\\_bar');
  });

  it('returns the input untouched when there is no underscore', () => {
    const value = 'nothing to see';
    expect(escapeDelimiterUnderscores(value, '', '')).toBe(value);
  });
});

describe('withNarrowedEscapes', () => {
  it.each(['snake_case_word', '#dog_problems', 'x_1 and y_2', 'a_b_c_d', 'file_name.txt'])(
    'leaves the intra-word underscores of %j alone',
    (input) => {
      expect(patched(input)).toBe(`${input}\n`);
    },
  );

  it.each([
    ['_em_', '\\_em\\_\n'],
    ['a _b_ c', 'a \\_b\\_ c\n'],
    ['_leading', '\\_leading\n'],
    ['trailing_', 'trailing\\_\n'],
    ['word _ alone', 'word \\_ alone\n'],
    ['(_paren_)', '(\\_paren\\_)\n'],
  ])('still escapes %j, where a `_` could open or close emphasis', (input, expected) => {
    expect(patched(input)).toBe(expected);
  });

  it.each(['tell us how you ____.', '__init__', 'an __id_ field', 'x__y', '___'])(
    'writes a run of underscores exactly as stock remark does: %j',
    (input) => {
      expect(patched(input)).toBe(serialize(input));
    },
  );

  it('keeps the line-leading `#` narrowing from atxEscape', () => {
    expect(patched('#alpha #beta')).toBe('#alpha #beta\n');
    expect(patched('# Heading')).toBe('\\# Heading\n');
  });

  it('does not disturb any other escape', () => {
    expect(patched('* not a list')).toBe(serialize('* not a list'));
    expect(patched('a *b* c')).toBe(serialize('a *b* c'));
    expect(patched('a \\_ b')).toBe(serialize('a \\_ b'));
  });

  /*
   * The property the census enforces: what this writes reads back as the same
   * text with no emphasis that was not there, and writing it again changes
   * nothing. A `_` left unescaped that CommonMark could read as emphasis fails
   * the first half; the two-pattern version failed the second.
   */
  it.each([
    'snake_case_word and #dog_problems',
    'tell us how you ____.',
    'an __id_ field',
    '__init__ and __main__',
    'x__y and a_b_c_',
    '_leading and trailing_ and _both_',
  ])('round-trips %j to the same text, and is a fixed point', (input) => {
    const once = patched(input);
    const tree = fromMarkdown(once);
    const texts: string[] = [];
    const walk = (node: { type: string; value?: string; children?: unknown[] }) => {
      if (node.type === 'text') texts.push(node.value ?? '');
      if (node.type === 'emphasis' || node.type === 'strong') texts.push(`<${node.type}>`);
      for (const child of node.children ?? []) walk(child as typeof node);
    };
    walk(tree as never);
    expect(texts.join('')).toBe(input);
    expect(toMarkdown(tree as never, { handlers: { text: narrowedText } as never })).toBe(once);
  });
});
