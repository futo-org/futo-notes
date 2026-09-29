import { expect, test, type Page } from '@playwright/test';

import { buildCensusPage } from './milkdown-census/build.mjs';

/**
 * Round-trip safety of the Milkdown compat plugins — executable.
 *
 * Every case runs twice against a real Milkdown editor built from the app's
 * plugin chain: once on `baseline` (the unpatched upstream preset) and once on
 * `compat` (what the app ships, `@futo-notes/editor/milkdown-compat`).
 *
 * The `baseline` half is the CANARY. It asserts the upstream bugs are still
 * present in `@milkdown/kit` 7.22.1. When upstream fixes one, its canary fails
 * — and that failure is the signal to delete the corresponding local fork
 * rather than carry it forever. Do not "fix" a red canary by relaxing it.
 *
 * The `compat` half is the contract: the two loss classes the census measured
 * are gone, and an empty paragraph round-trips as a blank line — never as the
 * `<br />` placeholder upstream's plugin exists for.
 */

let pageUrl: string;

test.beforeAll(async () => {
  pageUrl = await buildCensusPage();
});

test.beforeEach(async ({ page }) => {
  await page.goto(pageUrl);
});

/** One editor load: markdown in, the editor's own serialization back out. */
async function roundTrip(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  return page.evaluate(
    ([v, m]) => window.__futoCensus.load(v as 'compat' | 'baseline', m).then((r) => r.markdown),
    [variant, markdown] as const,
  );
}

test.describe('inline <br> survives (upstream deletes it with no replacement)', () => {
  const SENTENCES = 'sentence one.<br>sentence two.\n';
  const TABLE = '| a | b |\n| --- | --- |\n| one.<br>two. | x |\n';
  const TABLE_IN_QUOTE = '> | a | b |\n> | --- | --- |\n> | one.<br>two. | x |\n';

  test('canary: upstream still fuses the words on either side', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', SENTENCES)).toContain('sentence one.sentence two.');
    expect(await roundTrip(page, 'baseline', TABLE)).toContain('one.two.');
    expect(await roundTrip(page, 'baseline', TABLE_IN_QUOTE)).toContain('one.two.');
  });

  test('compat keeps the tag between two sentences', async ({ page }) => {
    expect(await roundTrip(page, 'compat', SENTENCES)).toBe(SENTENCES);
  });

  test('compat keeps the tag inside a table cell', async ({ page }) => {
    expect(await roundTrip(page, 'compat', TABLE)).toContain('one.<br>two.');
  });

  test('compat keeps the tag inside a table nested in a blockquote', async ({ page }) => {
    // The parked string-guard version could not see this container nesting and
    // left the note unstable across loads (census idx 25957).
    expect(await roundTrip(page, 'compat', TABLE_IN_QUOTE)).toContain('one.<br>two.');
  });

  test('compat keeps a tag on its own line inside a soft-wrapped paragraph', async ({ page }) => {
    expect(await roundTrip(page, 'compat', 'line a\n<br />\nline b\n')).toContain('<br />');
  });

  test('compat keeps the hard break before the tag, and adds no backslash', async ({ page }) => {
    // remark cannot write an eol directly before inline HTML, so a kept tag
    // left in second place strands the hard break's backslash mid-line:
    // "a  \n<br/>b" would come back as "a\\ <br/>b". Six census notes.
    const out = await roundTrip(page, 'compat', 'a  \n<br/>b\n');
    expect(out).toBe('a<br/>\\\nb\n');
    expect(await roundTrip(page, 'compat', out)).toBe(out);
  });
});

test.describe('an empty paragraph round-trips as a blank line, never as <br />', () => {
  // Upstream spells a non-final empty paragraph as a literal `<br />` on its
  // own line. The compat set retires that: N blank lines load as N-1 empty
  // paragraphs and save back as N blank lines (packages/editor/src/
  // milkdown-compat/emptyLine.ts). Each case is asserted twice — the first
  // save is allowed to re-spell (ADR-0002), the second must be a fixed point.
  // Fixed points of the census harness's serializer. `*`/`| - |` are
  // remark-stringify's defaults (the app sets `bullet: '-'` in its own config,
  // the harness does not).
  const STABLE: Record<string, string> = {
    'two blank lines between paragraphs': 'para one\n\n\npara two\n',
    'three blank lines between paragraphs': 'para one\n\n\n\npara two\n',
    'blank lines before the first block': '\n\npara\n',
    'two blank lines inside a blockquote': '> a\n>\n>\n> b\n',
    'two blank lines inside a list item': '* a\n\n\n  b\n* c\n',
    'an empty list item': '* a\n*\n* b\n',
    // The schema puts an empty paragraph in front of an item whose only content
    // is a block; that filler is not the note's and is not written
    // (packages/editor/src/milkdown-compat/listItemFiller.ts). Without that,
    // these save as a bare `*` over an indented block, and the NEXT save escapes
    // it to a literal `\*` — 60 census notes.
    'a list item holding only a blockquote': '* > quote\n* b\n',
    'a list item holding only a heading': '* # heading\n',
    'a list item holding only a nested list': '* * nested\n  * deeper\n',
    // Two lists with a gap between them: the second list alternates its marker
    // as if adjacent, or CommonMark would read the pair back as ONE list.
    'two bullet lists with a blank line between them': '* a\n\n\n- b\n',
    'two ordered lists with a blank line between them': '1. a\n\n\n1) b\n',
    'an empty table cell': '| a | b |\n| - | - |\n|   | x |\n',
  };

  for (const [name, markdown] of Object.entries(STABLE)) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const once = await roundTrip(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(await roundTrip(page, 'compat', once)).toBe(once);
    });
  }

  test('canary: upstream still round-trips its placeholder as <br />', async ({ page }) => {
    // Upstream cannot see blank lines at all (two of them load as one), so the
    // canary feeds it the tag it wrote itself: when this stops coming back as
    // `<br />`, upstream changed the placeholder scheme and this module's
    // legacy reader needs re-checking against it.
    const out = await roundTrip(page, 'baseline', 'para one\n\n<br />\n\npara two\n');
    expect(out).toContain('<br />');
    expect(await roundTrip(page, 'baseline', 'para one\n\n\npara two\n')).toBe(
      'para one\n\npara two\n',
    );
  });

  test('a blank line typed two Enters deep survives a reload as blank lines', async ({ page }) => {
    // The report that started this: "It's me!", Enter, Enter, "yes." saved as
    // a `<br />` line between the two. Same document, different spelling.
    const out = await roundTrip(page, 'compat', 'a\n\n\nb\n');
    expect(out).not.toContain('<br');
    expect(out).toBe('a\n\n\nb\n');
  });

  const LEGACY: Record<string, [string, string]> = {
    'a blank line between paragraphs': [
      'para one\n\n<br />\n\npara two\n',
      'para one\n\n\npara two\n',
    ],
    'an empty table cell': [
      '| a | b |\n| --- | --- |\n| <br /> | x |\n',
      '| a | b |\n| - | - |\n|   | x |\n',
    ],
    'an empty list item': ['- a\n- <br />\n- b\n', '* a\n*\n* b\n'],
    'an empty blockquote line': ['> <br />\n', '>\n'],
    'an empty footnote definition': ['ref[^4]\n\n[^4]: <br />\n', 'ref[^4]\n\n[^4]: \n'],
  };

  for (const [name, [legacy, respelled]] of Object.entries(LEGACY)) {
    test(`compat reads the placeholder an older build wrote for ${name}`, async ({ page }) => {
      const out = await roundTrip(page, 'compat', legacy);
      expect(out).not.toContain('<br');
      expect(out).toBe(respelled);
      expect(await roundTrip(page, 'compat', out)).toBe(out);
    });
  }
});

test.describe('the parked end-of-document paragraph is not written', () => {
  // @milkdown/plugin-trailing parks an empty paragraph after a last block that
  // is not a paragraph or heading, and the serializer wrote it as one more
  // blank line: the first edit of every such note ended the file in `\n\n`
  // (RC-22). The spec drops a trailing empty paragraph on save.
  test('canary: upstream still writes it as a blank line', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', '- a\n- b\n')).toBe('* a\n* b\n\n');
  });

  const LAST_BLOCKS: Record<string, string> = {
    'a list': '* a\n* b\n',
    'a task list': '* [ ] a\n* [x] b\n',
    'a blockquote': '> quote\n',
    'a table': '| a | b |\n| - | - |\n| 1 | 2 |\n',
    'a fence': '```\ncode\n```\n',
    'a thematic break': 'a\n\n***\n',
  };
  for (const [name, markdown] of Object.entries(LAST_BLOCKS)) {
    test(`compat ends a note whose last block is ${name} in one newline`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat still writes an empty paragraph that is not at the end', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'compat', '* a\n\n\npara\n');
    expect(once).toBe('* a\n\n\npara\n');
    expect(twice).toBe(once);
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

  const CASES: Record<string, [string, string]> = {
    'a trailing empty cell on the last row': [
      WIDE_LAST,
      'Prices\n\n| item  | price |   |\n| ----- | ----- | - |\n| apple | 3     |   |\n| pear  | 4     |   |\n\nend\n',
    ],
    'a wide middle row, alignment kept': [
      '| a | b |\n| :-: | -: |\n| 1 | 2 | 3 | 4 |\n| 5 | 6 |\n\nend\n',
      '|  a  |  b |   |   |\n| :-: | -: | - | - |\n|  1  |  2 | 3 | 4 |\n|  5  |  6 |   |   |\n\nend\n',
    ],
    'a row shorter than the header': [
      '| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 |\n\nend\n',
      '| a | b | c |\n| - | - | - |\n| 1 |   |   |\n| 2 | 3 |   |\n\nend\n',
    ],
    'a wide row in a blockquote': [
      '> | a | b |\n> | - | - |\n> | 1 | 2 | x |\n\nend\n',
      '> | a | b |   |\n> | - | - | - |\n> | 1 | 2 | x |\n\nend\n',
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

  test('canary: upstream injects a literal <br /> and a nested list', async ({ page }) => {
    const out = await roundTrip(page, 'baseline', BULLETS);
    expect(out).toContain('<br />');
    expect(out).toContain('  0. item one');
  });

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

test.describe('a keystroke in a heading leaves the heading alone', () => {
  const NOTE = '# hello\n\nbody\n';

  const churn = (page: Page, variant: 'compat' | 'baseline') =>
    page.evaluate(([v, m]) => window.__futoCensus.headingEditChurn(v as 'compat' | 'baseline', m), [
      variant,
      NOTE,
    ] as const);

  test('canary: upstream still re-stamps the id and re-creates the block', async ({ page }) => {
    const upstream = await churn(page, 'baseline');
    expect(upstream.idBefore).toBe('hello');
    expect(upstream.idAfter).not.toBe(upstream.idBefore);
    // The element the caret is in, replaced mid-typing. On WKWebView the next
    // character then lands at the START of the block, which is how `12345`
    // typed into a heading came out as `# 54321` (see milkdown-compat's doc).
    expect(upstream.sameElement).toBe(false);
  });

  test('compat keeps the same element and the same id', async ({ page }) => {
    const shipped = await churn(page, 'compat');
    expect(shipped.idAfter).toBe(shipped.idBefore);
    expect(shipped.sameElement).toBe(true);
  });
});

test.describe('YAML front matter survives the round trip', () => {
  // The bug report's note, verbatim. Three separate harms on the unpatched
  // preset: `---` → `***`, the closing `---` → a 16-dash setext underline, and
  // `tags: [a, b]` → `tags: \[a, b]` — a changed metadata VALUE, because the
  // serializer escapes what it reads as link syntax inside what it thinks is a
  // heading. ADR-0002 accepts re-spelling markdown; it explicitly does not
  // accept losing "constructs the editor's schema doesn't own (raw HTML,
  // wikilinks, footnotes, frontmatter)".
  const NOTE =
    '---\n' +
    'title: Front Matter Test\n' +
    'tags: [a, b]\n' +
    'date: 2026-09-01\n' +
    '---\n' +
    '\n' +
    '# Body\n' +
    '\n' +
    'Content after front matter.\n';

  test('canary: upstream rewrites the fences and escapes the metadata value', async ({ page }) => {
    const out = await roundTrip(page, 'baseline', NOTE);
    // Nothing in the unpatched parser recognises front matter, so the opening
    // `---` is a thematic break and the metadata lines are a setext heading.
    expect(out).toContain('***');
    expect(out).toContain('tags: \\[a, b]');
    expect(out).toMatch(/^-{16}$/m);
  });

  test('compat returns the note byte-for-byte', async ({ page }) => {
    expect(await roundTrip(page, 'compat', NOTE)).toBe(NOTE);
  });

  // Every character class the serializer would otherwise escape or re-spell in
  // prose. Front matter is YAML, not markdown: none of it may be touched.
  const HOSTILE = [
    ['bracket values', '---\ntags: [a, b]\n---\n\nbody\n'],
    ['a leading hash', '---\ncomment: "# not a heading"\n---\n\nbody\n'],
    ['asterisks and underscores', '---\nglob: "*.md"\nsnake: a_b_c\n---\n\nbody\n'],
    ['single and double quotes', `---\nq: 'it''s'\nd: "say \\"hi\\""\n---\n\nbody\n`],
    ['nested indentation', '---\nauthors:\n  - name: A\n    role: b\n---\n\nbody\n'],
    ['a wikilink-looking value', '---\nrel: "[[Other Note]]"\n---\n\nbody\n'],
    ['a blank line inside', '---\na: 1\n\nb: 2\n---\n\nbody\n'],
    ['a trailing-space value', '---\na: 1 \n---\n\nbody\n'],
    ['an empty block', '---\n---\n\nbody\n'],
  ] as const;

  for (const [label, markdown] of HOSTILE) {
    test(`compat preserves ${label}`, async ({ page }) => {
      expect(await roundTrip(page, 'compat', markdown)).toBe(markdown);
    });
  }

  test('compat keeps a note with no body at all byte-for-byte', async ({ page }) => {
    // The doc's content expression is `frontmatter? block+`, so a document
    // parsed as nothing but front matter gets ProseMirror's required empty
    // paragraph filled in — the caret's only place that is not a selection ON
    // the metadata. It is a trailing empty paragraph, which is not written
    // (milkdown-compat/trailingParagraph.ts), so it costs the file nothing.
    expect(await roundTrip(page, 'compat', '---\na: 1\n---\n')).toBe('---\na: 1\n---\n');
  });

  test('compat leaves a mid-document `---` a thematic break', async ({ page }) => {
    // Front matter is a document-start construct only. A horizontal rule
    // further down is still a horizontal rule, and still normalizes to `***`
    // the way it always did.
    const out = await roundTrip(page, 'compat', 'intro\n\n---\n\nafter\n');
    expect(out).toContain('***');
    expect(out).not.toContain('---\n\nafter');
  });

  test('compat leaves an opening thematic break alone', async ({ page }) => {
    // `---` followed by a blank line is not front matter (no closing fence),
    // and must keep parsing as the rule it is rather than swallowing the note.
    const out = await roundTrip(page, 'compat', '---\n\nbody\n');
    expect(out).toContain('***');
    expect(out).toContain('body');
  });

  test('compat leaves an unterminated `---` block alone', async ({ page }) => {
    // No closing fence anywhere: CommonMark reads this as a thematic break
    // plus a paragraph, and so must we — inventing a front matter block here
    // would swallow the rest of the note into an inert node.
    const out = await roundTrip(page, 'compat', '---\ntitle: x\n\nbody\n');
    expect(out).toContain('title: x');
    expect(out).toContain('body');
  });

  // An opening `---` with no closing fence (RC-07). The front matter construct
  // is `concrete`, so while it hunts for a closing fence micromark checks no
  // container on any later line; when the hunt fails at the end of the file,
  // every line is replayed as if no list or quote had ever opened.
  const UNCLOSED =
    '---\n\nShopping\n\n- milk\n  - skim\n- [ ] eggs\n\n> quoted\n\nx[^1]\n\n[^1]: a note\n\nend\n';

  // Its canary is a unit test beside the guard, because the unpatched preset
  // has no front matter at all: packages/editor/src/milkdown-compat/frontmatter.test.ts.

  test('compat keeps the lists, task, quote and footnote after an unclosed fence', async ({
    page,
  }) => {
    const { once, twice } = await twoSaves(page, 'compat', UNCLOSED);
    expect(once).toBe(
      '***\n\nShopping\n\n* milk\n  * skim\n* [ ] eggs\n\n> quoted\n\nx[^1]\n\n[^1]: a note\n\nend\n',
    );
    expect(twice).toBe(once);
  });

  test('compat reads a CRLF note with an unclosed fence the same way', async ({ page }) => {
    const out = await roundTrip(page, 'compat', '---\r\n\r\n- milk\r\n\r\n> quoted\r\n');
    expect(out).not.toContain('\\-');
    expect(out).toContain('> quoted');
  });

  test('compat still finds a closing fence after an interior blank line and a list', async ({
    page,
  }) => {
    // The guard asks only "is there a closing fence"; this block has one, so it
    // stays front matter, YAML list included.
    const note = '---\ntags:\n\n  - a\n---\n\n- body\n\nend\n';
    expect(await roundTrip(page, 'compat', note)).toBe(
      '---\ntags:\n\n  - a\n---\n\n* body\n\nend\n',
    );
  });
});

/** Two loads: what the first save writes, and whether the second agrees. */
async function twoSaves(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  const once = await roundTrip(page, variant, markdown);
  return { once, twice: await roundTrip(page, variant, once) };
}

test.describe('a text run that ends in whitespace keeps its escapes', () => {
  // `@milkdown/core`'s `text` handler returns any run matching
  // /^[^*_\\]*\s+$/ RAW, before `safe()` (it exists to keep a trailing space
  // from being written as `&#x20;`). A run ends in whitespace whenever the
  // next inline sibling is not text — a mark, a link, an image, inline HTML —
  // so every escape CommonMark needs in that run was dropped: `\#` at a line
  // start reopened as a heading, `\|` in a cell split the row, `\&amp;`
  // decoded to `&`.
  const SHAPES: Record<string, string> = {
    'an escaped # before bold': 'x\n\n\\# a **b**\n',
    'an escaped > before bold': 'x\n\n\\> a **b**\n',
    'an escaped - before a link': 'x\n\n\\- a [b](https://e.example/u)\n',
    'an escaped 1. before code': 'x\n\n1\\. a `b`\n',
    'an escaped - on a soft-wrapped line': 'a\n\\- b **c**\n',
    'an escaped &amp; before bold': 'Tom \\&amp; Jerry **x**\n',
    'escaped [[ before bold': '\\[\\[x]] **b**\n',
    'an escaped <div> before bold': '\\<div> **b**\n',
  };

  test('canary: upstream still writes the run unescaped', async ({ page }) => {
    expect(await roundTrip(page, 'baseline', SHAPES['an escaped # before bold'])).toBe(
      'x\n\n# a **b**\n',
    );
    expect(await roundTrip(page, 'baseline', SHAPES['an escaped &amp; before bold'])).toBe(
      'Tom &amp; Jerry **x**\n',
    );
    expect(await roundTrip(page, 'baseline', SHAPES['an escaped - on a soft-wrapped line'])).toBe(
      'a\n- b **c**\n',
    );
  });

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
  // part of the URL. Upstream `safe()` still escapes a backslash that precedes
  // punctuation, the next open reads both as literal, and the count doubles on
  // every save (2^n churn, census `unstable_persistent`).
  test('canary: upstream still doubles the backslash every save', async ({ page }) => {
    const { once, twice } = await twoSaves(
      page,
      'baseline',
      'see <https://example.com/a\\.b> here\n',
    );
    expect(once).toBe('see <https://example.com/a\\\\.b> here\n');
    expect(twice).toBe('see <https://example.com/a\\\\\\\\.b> here\n');
  });

  for (const markdown of [
    'see <https://example.com/a\\.b> here\n',
    'see <file:\\\\srv\\s> here\n',
    'see <https://example.com/a\\> here\n',
  ]) {
    test(`compat round-trips ${JSON.stringify(markdown)} byte-for-byte`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat writes a bare URL with a backslash once, then holds', async ({ page }) => {
    // The bare (GFM literal) form is re-spelled as `<...>` — accepted
    // normalization — but keeps exactly the one backslash it had.
    const { once, twice } = await twoSaves(page, 'compat', 'see https://example.com/a\\_b now\n');
    expect(once).toBe('see <https://example.com/a\\_b> now\n');
    expect(twice).toBe(once);
  });
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
    ['a tag inside a list item', "* text <span\n      a='1'>t</span> end\n"],
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

test.describe('a hard break directly before inline HTML', () => {
  // mdast-util-to-markdown cannot write an eol directly before inline HTML (it
  // could open an HTML block), so it replaces it with a space — which strands
  // a hard break's backslash mid-line as a literal `\`. The app's `break`
  // handler (src/features/editor/milkdown/table/tableLineBreak.ts) spells such
  // a break `<br>` instead; that half is asserted on the shipped bundle in
  // editor-embed-milkdown-interactive.spec.ts, because the census page does not
  // mount the app's table feature.
  test('canary: upstream still writes a literal backslash and joins the lines', async ({
    page,
  }) => {
    expect(await roundTrip(page, 'baseline', 'a  \n<span>b</span>\n')).toBe('a\\ <span>b</span>\n');
  });
});

test.describe('bold or italic whose edge is punctuation next to a letter', () => {
  // A `**` run next to punctuation on its inner side and a letter on its outer
  // side is not left-/right-flanking (CommonMark §6.2), so it does not open or
  // close. Upstream mdast-util-to-markdown writes the outer letter as a
  // character reference there (`encodeInfo`); `@milkdown/core` replaces its
  // strong and emphasis handlers with ones that do not, so the formatting
  // reopened as literal `**` and the next save escaped it for good.
  const SHAPES: Record<string, string> = {
    'bold ending in a colon before a letter': '**Note:**&#x62;ar\n',
    'italic ending in a colon before a letter': '*Note:*&#x62;ar\n',
    'italic parentheses inside a word': '&#x61;*(b)*&#x63;\n',
    // CJK: bold ending in a full-width colon before the next ideograph.
    'CJK bold ending in a full-width colon': '**重要：**&#x8FD9;是\n',
  };

  test('canary: upstream Milkdown still writes the run unencoded', async ({ page }) => {
    const { once, twice } = await twoSaves(
      page,
      'baseline',
      SHAPES['bold ending in a colon before a letter'],
    );
    expect(once).toBe('**Note:**bar\n');
    expect(twice).toBe('\\*\\*Note:\\*\\*bar\n');
  });

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat keeps ${name} byte-for-byte`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat leaves a run that already opens and closes alone', async ({ page }) => {
    for (const markdown of ['**Note:** bar\n', 'a **b** c\n', '__a__ b\n', '*x*y\n']) {
      expect(await roundTrip(page, 'compat', markdown)).toBe(markdown);
    }
  });
});

test.describe('strikethrough whose edge is punctuation next to a letter', () => {
  // The same flanking rule as bold and italic (GFM strikethrough classifies
  // its neighbours the way `*` does), and `mdast-util-gfm-strikethrough`'s
  // `delete` handler has no `encodeInfo` at all: `~~Note:~~bar` reopened as
  // literal tildes and the next save escaped them for good.
  const STRUCK = '~~Note:~~&#x62;ar\n';

  test('canary: upstream still writes the run unencoded', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'baseline', STRUCK);
    expect(once).toBe('~~Note:~~bar\n');
    expect(twice).toBe('\\~\\~Note:\\~\\~bar\n');
  });

  test('compat keeps it byte-for-byte', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'compat', STRUCK);
    expect(once).toBe(STRUCK);
    expect(twice).toBe(once);
  });

  test('compat leaves a strikethrough that already flanks alone', async ({ page }) => {
    expect(await roundTrip(page, 'compat', 'a ~~b~~ c\n')).toBe('a ~~b~~ c\n');
  });
});

test.describe('an underscore emphasis next to a `*` run is never re-spelled', () => {
  // Guard for a dropped approach (FB-4a round 2): writing `*` in place of an
  // `_` run that could only flank encoded ignores a neighbouring or enclosing
  // `*` run, so `Z*b**c*` reopened with two literal `**` in the text. The
  // references are ugly but correct; the bytes must hold and no `*` may appear
  // that the document did not have.
  const SHAPES: Record<string, string> = {
    'an italic then a `*` italic': 'a &#x5A;_&#x62;_*c*\n',
    'a bold then a `*` italic': 'a &#x5A;__&#x62;__*c*\n',
    'a letter, an italic, a `*` italic': '&#x62;_c_*d*\n',
    'a `*` italic, an italic, a letter': '*d*_c_&#x62;\n',
    'an italic ending a `*` italic': 'x*a &#x62;_c_*y\n',
  };

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat holds ${name} and reopens to the same document`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(twice).toBe(once);
      // A switched marker would leave `**` behind; no shape here should.
      expect(once).not.toContain('**');
    });
  }
});
