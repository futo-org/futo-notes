// Part of the Milkdown compat suite: the round-trip contract is described in
// editor-embed-milkdown-compat.spec.ts.

import { expect, test } from '@playwright/test';
import {
  useCensusPage,
  roundTrip,
  twoSaves,
  withoutMarkers,
} from './lib/editorEmbedMilkdownCompat';

useCensusPage();

test.describe('a text run that ends in whitespace keeps its escapes', () => {
  // `@milkdown/core`'s `text` handler returned any run matching
  // /^[^*_\\]*\s+$/ RAW, before `safe()` (it exists to keep a trailing space
  // from being written as `&#x20;`). A run ends in whitespace whenever the
  // next inline sibling is not text — a mark, a link, an image, inline HTML —
  // so every escape CommonMark needs in that run was dropped: `\#` at a line
  // start reopened as a heading, `\|` in a cell split the row, `\&amp;`
  // decoded to `&`. These shapes hold the owned serializer to keeping them.
  const SHAPES: Record<string, string> = {
    'an escaped # before bold': 'x\n\n\\# a **b**\n',
    'an escaped > before bold': 'x\n\n\\> a **b**\n',
    'an escaped - before a link': 'x\n\n\\- a [b](https://e.example/u)\n',
    'an escaped 1. before code': 'x\n\n1\\. a `b`\n',
    'an escaped - on a soft-wrapped line': 'a\n\\- b **c**\n',
    'an escaped &amp; before bold': 'Tom \\&amp; Jerry **x**\n',
    'an escaped [[ before bold': '\\[[x]] **b**\n',
    'an escaped <div> before bold': '\\<div> **b**\n',
  };

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat keeps an escaped marker after a hard break a paragraph', async ({ page }) => {
    // The hard break re-spells (two spaces -> backslash); the marker must not
    // reopen as a list, and no literal backslash may be invented.
    const { once, twice } = await twoSaves(page, 'compat', 'a  \n\\- b **c**\n');
    expect(once).toBe('a\\\n\\- b **c**\n');
    expect(twice).toBe(once);
  });

  test('compat keeps an escaped pipe before bold inside its table cell', async ({ page }) => {
    const { once, twice } = await twoSaves(
      page,
      'compat',
      '| a | b |\n| - | - |\n| x \\| y **b** | d |\n',
    );
    expect(once).toMatch(/^\| x \\\| y \*\*b\*\* \| d +\|$/m);
    expect(twice).toBe(once);
  });
});

test.describe('an autolink with a backslash is written verbatim', () => {
  // CommonMark processes no backslash escapes inside `<...>`, so the `\` is
  // part of the URL. remark's `safe()` escaped a backslash that precedes
  // punctuation, the next open read both as literal, and the count doubled on
  // every save (2^n churn, census `unstable_persistent`).
  // Either spelling keeps exactly the one backslash: an http(s) URL is written
  // bare (a GFM literal processes no escapes either, and the serializer
  // re-parses the bare spelling to prove it is the same link), anything else
  // keeps its `<...>`.
  for (const [markdown, saved] of [
    ['see <file:\\\\srv\\s> here\n', 'see <file:\\\\srv\\s> here\n'],
    ['see <https://example.com/a\\> here\n', 'see https://example.com/a\\ here\n'],
    ['see https://example.com/a\\_b now\n', 'see https://example.com/a\\_b now\n'],
  ]) {
    test(`compat writes ${JSON.stringify(markdown)} with its one backslash, then holds`, async ({
      page,
    }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(saved);
      expect(twice).toBe(once);
    });
  }
});

test.describe('a multi-line inline HTML tag keeps its continuation indent', () => {
  // micromark drops up to three columns of each continuation line's indent
  // from an inline HTML node's value (the line prefix), and the serializer
  // writes the value back verbatim, so the indent shrank by three on every
  // save until it reached column 0.
  const TAG = "<span\n    class='a'\n       data-img = 'b'\n    data-end='1'>\n";
  const MID = "text <span\n       a='1'>t</span> end\n";

  test('canary: upstream still strips three columns per save', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'baseline', MID);
    expect(once).toBe("text <span\n    a='1'>t</span> end\n");
    expect(twice).toBe("text <span\n a='1'>t</span> end\n");
  });

  for (const [name, markdown] of [
    ['a tag that starts the paragraph', TAG],
    ['a tag in mid-paragraph', MID],
    ['a tag inside a blockquote', "> text <span\n>     a='1'>t</span> end\n"],
    ['a tag inside a list item', "- text <span\n      a='1'>t</span> end\n"],
  ] as const) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat leaves an indented block of HTML alone', async ({ page }) => {
    // Flow HTML keeps its lines verbatim on parse; nothing may be added.
    expect(await roundTrip(page, 'compat', '<div>\n    x\n</div>\n')).toBe(
      '<div>\n    x\n</div>\n',
    );
  });
});

test.describe('bold or italic whose edge is punctuation next to a letter', () => {
  // A `**` run next to punctuation on its inner side and a letter on its outer
  // side is not left-/right-flanking (CommonMark §6.2), so it does not open or
  // close. mdast-util-to-markdown writes the outer letter as a character
  // reference there (`encodeInfo`); `@milkdown/core` replaced its strong and
  // emphasis handlers with ones that did not, so the formatting reopened as
  // literal `**` and the next save escaped it for good. The house style writes
  // the reference wherever a parse says flanking needs one.
  const SHAPES: Record<string, string> = {
    'italic ending in a colon before a letter': '*Note:*&#x62;ar\n',
    'italic parentheses inside a word': '&#x61;*(b)*&#x63;\n',
  };

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat leaves a run that already opens and closes alone', async ({ page }) => {
    for (const markdown of ['**Note:** bar\n', 'a **b** c\n', '*x*y\n']) {
      expect(await roundTrip(page, 'compat', markdown)).toBe(markdown);
    }
    // `__` is bold, written in the house style's `**`, and still needs no reference.
    expect(await roundTrip(page, 'compat', '__a__ b\n')).toBe('**a** b\n');
  });
});

test.describe('strikethrough whose edge is punctuation next to a letter', () => {
  // The same flanking rule as bold and italic (GFM strikethrough classifies
  // its neighbors the way `*` does), and `mdast-util-gfm-strikethrough`'s
  // `delete` handler has no `encodeInfo` at all: `~~Note:~~bar` reopened as
  // literal tildes and the next save escaped them for good.
  const STRUCK = '~~Note:~~&#x62;ar\n';

  test('compat keeps it byte-for-byte', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'compat', STRUCK);
    expect(once).toBe(STRUCK);
    expect(twice).toBe(once);
  });

  test('compat leaves a strikethrough that already flanks alone', async ({ page }) => {
    expect(await roundTrip(page, 'compat', 'a ~~b~~ c\n')).toBe('a ~~b~~ c\n');
  });
});

test.describe('an underscore emphasis next to a `*` run reopens as the same document', () => {
  // Guard for a dropped approach (FB-4a round 2): writing `*` in place of an
  // `_` run that could only flank encoded ignores a neighboring or enclosing
  // `*` run, so `Z*b**c*` reopened with two literal `**` in the text. The house
  // style writes `*` wherever a parse says the runs do not merge, and `_` where
  // they would; either way the save reopens as the document it was.
  const SHAPES: Record<string, string> = {
    'an italic then a `*` italic': 'a &#x5A;_&#x62;_*c*\n',
    'a bold then a `*` italic': 'a &#x5A;__&#x62;__*c*\n',
    'a letter, an italic, a `*` italic': '&#x62;_c_*d*\n',
    'a `*` italic, an italic, a letter': '*d*_c_&#x62;\n',
    'an italic ending a `*` italic': 'x*a &#x62;_c_*y\n',
  };

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat holds ${name} and reopens to the same document`, async ({ page }) => {
      const read = (m: string) => page.evaluate((md) => window.__futoCensus.load('compat', md), m);
      const first = await read(markdown);
      const second = await read(first.markdown);
      expect(second.markdown).toBe(first.markdown);
      // A switched marker would leave literal `**` behind: compared with only
      // the `*`/`_` spelling taken out (`withoutMarkers`).
      expect(withoutMarkers(second.docJson), first.markdown).toBe(withoutMarkers(first.docJson));
    });
  }
});
