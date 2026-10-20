// Part of the Milkdown compat suite: the round-trip contract is described in
// editor-embed-milkdown-compat.spec.ts.

import { expect, test } from '@playwright/test';
import { useCensusPage, roundTrip, pastePlain, twoSaves } from './lib/editorEmbedMilkdownCompat';

useCensusPage();

test.describe('a pasted table keeps the alignment it was written with', () => {
  // A paste goes through the DOM, and the gfm preset spells a cell's missing
  // alignment there as `text-align: left` and reads it back as `left`: a
  // pasted `| --- |` table saved as `| :- |`, while opening the same table and
  // editing it saved `| -- |` (RC-59).
  const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';

  test('canary: upstream still invents left alignment on paste', async ({ page }) => {
    expect(await pastePlain(page, 'baseline', TABLE)).toContain('| :- | :- |');
  });

  test('compat writes a pasted table the way it writes an opened one', async ({ page }) => {
    const opened = await roundTrip(page, 'compat', TABLE);
    // The leading blank line is a separate thing: Milkdown's plain-text route
    // pastes a maximally open slice, which leaves the empty paragraph above.
    expect((await pastePlain(page, 'compat', TABLE)).replace(/^\n/, '')).toBe(opened);
  });

  test('compat keeps an explicit alignment through a paste', async ({ page }) => {
    const aligned = '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n';
    expect(await pastePlain(page, 'compat', aligned)).toContain('| :-- | :-: | --: |');
  });
});

test.describe('a link reference definition nothing uses survives', () => {
  // The preset's remark-inline-links deletes EVERY definition and inlines the
  // references that used one. Inlining a used definition is an accepted
  // re-spelling (Q17 17B); deleting an unused one lost its URL and title on
  // the first edit, and a note of nothing but definitions saved as ''.
  const UNUSED = 'Some text here.\n\n[docs]: https://example.com/docs\n';

  test('canary: upstream still deletes an unused definition', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', UNUSED)).toBe('Some text here.\n');
    expect(await roundTrip(page, 'baseline', '[a]: https://a.example\n')).toBe('');
  });

  const VERBATIM: Record<string, string> = {
    'an unused definition': UNUSED,
    'a note of nothing but definitions': '[a]: https://a.example\n[b]: https://b.example "B"\n',
    'a definition referenced only from code': 'use `[docs]` here\n\n[docs]: https://e.example/d\n',
    'a definition inside a blockquote': '> [q]: https://q.example\n\nend\n',
    'a definition with extra blank lines after it': 'a\n\n[x]: /u\n\n\nb\n',
  };
  for (const [name, markdown] of Object.entries(VERBATIM)) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  const INLINED: Record<string, [string, string]> = {
    // No empty paragraphs where the definition was: its lines are not a gap.
    'a used definition': [
      'See [docs] now.\n\n[docs]: https://example.com/docs "T"\n\nafter\n',
      'See [docs](https://example.com/docs "T") now.\n\nafter\n',
    ],
    'a used definition next to an unused one': [
      'See [a].\n\n[a]: /1\n[b]: /2\n\nend\n',
      'See [a](/1).\n\n[b]: /2\n\nend\n',
    ],
    // The blank lines before a used definition that ended its container are
    // trailing once it is gone, and are dropped like any other trailing gap.
    'a used definition that ends a blockquote': [
      '> See [a].\n>\n>\n> [a]: /u\n\nend\n',
      '> See [a](/u).\n\nend\n',
    ],
    // CommonMark: the first definition of a label wins; the second is unused.
    'a duplicate label': [
      'See [a].\n\n[a]: /1\n[a]: /2\n\nend\n',
      'See [a](/1).\n\n[a]: /2\n\nend\n',
    ],
  };
  for (const [name, [markdown, expected]] of Object.entries(INLINED)) {
    test(`compat inlines ${name} and keeps the rest`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(expected);
      expect(twice).toBe(once);
    });
  }
});

test.describe('a table row wider than the header keeps every value in its column', () => {
  // prosemirror-tables' fixTables squares a ragged table up by inserting the
  // missing cells at the START of each short row above the wide one, so their
  // values saved one column right, under the wrong header (RC-42). Padding
  // happens at the END instead, header included (Q13 option 13A).
  const WIDE_LAST = 'Prices\n\n| item | price |\n| - | - |\n| apple | 3 |\n| pear | 4 | |\n\nend\n';

  test('canary: upstream still shifts the rows above the wide one', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', WIDE_LAST)).toMatch(/^\| <br \/> \| apple +\|/m);
  });

  // Written in the house style: no column padding, `---` delimiters.
  const CASES: Record<string, [string, string]> = {
    'a trailing empty cell on the last row': [
      WIDE_LAST,
      'Prices\n\n| item | price |  |\n| --- | --- | --- |\n| apple | 3 |  |\n| pear | 4 |  |\n\nend\n',
    ],
    'a wide middle row, alignment kept': [
      '| a | b |\n| :-: | -: |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |\n\nend\n',
      '| a | b |  |  |\n| :-: | --: | --- | --- |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |  |  |\n\nend\n',
    ],
    'a row shorter than the header': [
      '| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 |\n\nend\n',
      '| a | b | c |\n| --- | --- | --- |\n| 1 |  |  |\n| 2 | 3 |  |\n\nend\n',
    ],
    'a wide row in a blockquote': [
      '> | a | b |\n> | - | - |\n> | 1 | 2 | x |\n\nend\n',
      '> | a | b |  |\n> | --- | --- | --- |\n> | 1 | 2 | x |\n\nend\n',
    ],
  };
  for (const [name, [markdown, expected]] of Object.entries(CASES)) {
    test(`compat pads ${name} at the end`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(expected);
      expect(twice).toBe(once);
    });
  }
});

test.describe('empty-label links keep their href', () => {
  const LINK = '## h\n\n[](api-plan.md)\n';

  test('canary: upstream deletes the link outright', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', LINK)).not.toContain('api-plan.md');
  });

  test('compat gives the link its URL as visible text', async ({ page }) => {
    expect(await roundTrip(page, 'compat', LINK)).toContain('[api-plan.md](api-plan.md)');
  });

  test('compat leaves an image with empty alt text alone', async ({ page }) => {
    // A decorative image is a different mdast node and already lossless. The
    // earlier regex fix rewrote every one of these.
    expect(await roundTrip(page, 'compat', '![](pic.png)\n')).toBe('![](pic.png)\n');
  });
});

test.describe('numbered-looking bullets follow CommonMark', () => {
  const BULLETS = '* 0. item one\n* 1. item two\n';

  test('compat preserves CommonMark nesting without injecting a filler', async ({ page }) => {
    const out = await roundTrip(page, 'compat', BULLETS);
    expect(out).not.toContain('<br />');
    expect(out).not.toContain('0\\. item one');
    expect(out).toContain('0. item one');
    expect(await roundTrip(page, 'compat', out)).toBe(out);
  });

  test('compat leaves markdown inside a fence alone', async ({ page }) => {
    // The serializer's own trailing blank line is not this fix's business, so
    // assert on the fence body rather than the whole string.
    const out = await roundTrip(page, 'compat', '```md\n* 0. sample\n```\n');
    expect(out).toContain('* 0. sample');
    expect(out).not.toContain('0\\.');
  });
});

test.describe('unrelated inline HTML is untouched', () => {
  for (const markdown of ['press <kbd>K</kbd> now\n', '<!-- a comment -->\n\ntext\n']) {
    test(`compat round-trips ${JSON.stringify(markdown)}`, async ({ page }) => {
      expect(await roundTrip(page, 'compat', markdown)).toBe(markdown);
    });
  }
});
