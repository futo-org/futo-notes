import { expect, test, type Page } from '@playwright/test';

import { buildCensusPage } from './milkdown-census/build.mjs';

/**
 * Round-trip safety of the Milkdown compat plugins and the editor's own
 * serializer — executable.
 *
 * Every case runs against a real Milkdown editor built from the app's plugin
 * chain: on `baseline` (the unpatched upstream preset, read and written by
 * remark) and on `compat` (what the app ships: `@futo-notes/editor/milkdown-
 * compat` reading, the owned serializer writing in the house style of
 * docs/spec/editor.md "Markdown house style").
 *
 * The `baseline` half is the CANARY. It asserts the upstream bugs are still
 * present in `@milkdown/kit` 7.22.1. When upstream fixes one, its canary fails
 * — and that failure is the signal to delete the corresponding local fork
 * rather than carry it forever. Do not "fix" a red canary by relaxing it. The
 * canaries of the remark-stringify patches went with the patches when the
 * owned serializer replaced them (#266): what they guarded is now the
 * serializer's, held by its goldens (tests/conformance/markdown-house-style.json).
 *
 * The `compat` half is the contract: the two loss classes the census measured
 * are gone, and an empty paragraph round-trips as a blank line — never as the
 * `<br />` placeholder upstream's plugin exists for.
 */

let pageUrl: string;

interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
  content?: JsonNode[];
}

/**
 * A document (`doc.toJSON()`) with the one thing the house style re-spells in
 * the inline-mark tests below taken out: an emphasis or strong run's `marker`,
 * which records whether the FILE wrote `*` or `_` (a save writes `*` and only
 * falls back to `_` where two `*` runs would merge). Text runs that then carry
 * the same marks are one run, as `_a_*b*` saved as `*ab*` reads back.
 * Everything else — text, which marks, where they start and end, links,
 * structure, every other attribute — must match exactly. Deliberately
 * narrower than the census `houseDocument`, which also forgives
 * normalizations (whitespace at a line end, empty paragraphs, CR, layout)
 * these tests have no reason to.
 */
function withoutMarkers(doc: unknown): string {
  const strip = (node: JsonNode): JsonNode => {
    const out: JsonNode = { ...node };
    if (node.marks) {
      out.marks = node.marks.map((mark) => {
        if (!mark.attrs || !('marker' in mark.attrs)) return mark;
        const { marker: _marker, ...attrs } = mark.attrs;
        return Object.keys(attrs).length > 0 ? { ...mark, attrs } : { type: mark.type };
      });
    }
    if (node.content) {
      const merged: JsonNode[] = [];
      for (const child of node.content.map(strip)) {
        const last = merged[merged.length - 1];
        const sameMarks = JSON.stringify(last?.marks) === JSON.stringify(child.marks);
        if (last?.type === 'text' && child.type === 'text' && sameMarks) {
          merged[merged.length - 1] = { ...last, text: `${last.text ?? ''}${child.text ?? ''}` };
        } else merged.push(child);
      }
      out.content = merged;
    }
    return out;
  };
  return JSON.stringify(strip(doc as JsonNode));
}

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
  // Fixed points of the house style (docs/spec/editor.md "Markdown house
  // style"): `-` bullets, `---` delimiter rows, one space either side of a cell.
  const STABLE: Record<string, string> = {
    'two blank lines between paragraphs': 'para one\n\n\npara two\n',
    'three blank lines between paragraphs': 'para one\n\n\n\npara two\n',
    'blank lines before the first block': '\n\npara\n',
    'two blank lines inside a blockquote': '> a\n>\n>\n> b\n',
    'two blank lines inside a list item': '- a\n\n\n  b\n- c\n',
    'an empty list item': '- a\n-\n- b\n',
    // The schema puts an empty paragraph in front of an item whose only content
    // is a block; that filler is not the note's and is not written. Written, it
    // would save as a bare `-` over an indented block, and the NEXT save would
    // escape it to a literal `\-` — 60 census notes before the fix.
    'a list item holding only a blockquote': '- > quote\n- b\n',
    'a list item holding only a heading': '- # heading\n',
    'a list item holding only a nested list': '- - nested\n  - deeper\n',
    // Two lists with a gap between them: the second list alternates its marker
    // as if adjacent, or CommonMark would read the pair back as ONE list.
    'two bullet lists with a blank line between them': '- a\n\n\n* b\n',
    'two ordered lists with a blank line between them': '1. a\n\n\n1) b\n',
    'an empty table cell': '| a | b |\n| --- | --- |\n|  | x |\n',
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
      '| a | b |\n| --- | --- |\n|  | x |\n',
    ],
    'an empty list item': ['- a\n- <br />\n- b\n', '- a\n-\n- b\n'],
    'an empty blockquote line': ['> <br />\n', '>\n'],
    'an empty footnote definition': ['ref[^4]\n\n[^4]: <br />\n', 'ref[^4]\n\n[^4]:\n'],
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
  // is not a paragraph or heading, and remark-stringify wrote it as one more
  // blank line: the first edit of every such note ended the file in `\n\n`
  // (RC-22). The spec drops a trailing empty paragraph on save.
  const LAST_BLOCKS: Record<string, string> = {
    'a list': '- a\n- b\n',
    'a task list': '- [ ] a\n- [x] b\n',
    'a blockquote': '> quote\n',
    'a table': '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    'a fence': '```\ncode\n```\n',
    'a thematic break': 'a\n\n---\n',
  };
  for (const [name, markdown] of Object.entries(LAST_BLOCKS)) {
    test(`compat ends a note whose last block is ${name} in one newline`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).toBe(markdown);
      expect(twice).toBe(once);
    });
  }

  test('compat still writes an empty paragraph that is not at the end', async ({ page }) => {
    const { once, twice } = await twoSaves(page, 'compat', '- a\n\n\npara\n');
    expect(once).toBe('- a\n\n\npara\n');
    expect(twice).toBe(once);
  });
});

/** A plain-text paste into an empty editor, through Milkdown's clipboard plugin. */
async function pastePlain(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  return page.evaluate(
    ([v, m]) => window.__futoCensus.pastePlainText(v as 'compat' | 'baseline', m),
    [variant, markdown] as const,
  );
}

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

test.describe('an IME commit between two inline nodes ends the composition', () => {
  // Two images side by side: the caret between them is the spot upstream's
  // `inlineNodesCursorPlugin` takes over. Its `compositionend` handler claimed
  // the event, so ProseMirror never ended the composition and `view.composing`
  // stayed set after the commit (FB-19, L6f-2) — which switches off markdown
  // input rules and pins the host's `isComposing()`. The shipped plugin
  // (milkdown-compat/inlineNodesCursor.ts) lets ProseMirror's handler run. The
  // wikilink-chip version of this, with input rules and line edges, is in
  // editor-embed-milkdown-wikilinks.spec.ts; this half needs the UNPATCHED preset.
  const NOTE = '![a](a.png)![b](b.png)\n';

  async function composingAfterCommit(page: Page, variant: 'compat' | 'baseline') {
    await page.evaluate(
      async ([v, m]) => {
        (window as unknown as { __ime: unknown }).__ime = await window.__futoCensus.mountForIme(
          v as 'compat' | 'baseline',
          m,
        );
      },
      [variant, NOTE] as const,
    );
    const cdp = await page.context().newCDPSession(page);
    for (const text of ['ni', 'nihao'])
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    await cdp.send('Input.insertText', { text: 'NIHAO' });
    await page.waitForTimeout(100);
    return page.evaluate(() =>
      (window as unknown as { __ime: { composing(): boolean } }).__ime.composing(),
    );
  }

  test('canary: upstream still leaves view.composing set after the commit', async ({ page }) => {
    expect(await composingAfterCommit(page, 'baseline')).toBe(true);
  });

  test('compat ends the composition', async ({ page }) => {
    expect(await composingAfterCommit(page, 'compat')).toBe(false);
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
    // further down is still a horizontal rule, written `---` (the house style),
    // and reads back as one: the note is a fixed point.
    const { once, twice } = await twoSaves(page, 'compat', 'intro\n\n---\n\nafter\n');
    expect(once).toBe('intro\n\n---\n\nafter\n');
    expect(twice).toBe(once);
  });

  test('compat leaves an opening thematic break alone', async ({ page }) => {
    // `---` followed by a blank line is not front matter (no closing fence),
    // and must keep parsing as the rule it is rather than swallowing the note.
    // On the first line the house style writes it `***`, which cannot open
    // front matter.
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
      '***\n\nShopping\n\n- milk\n  - skim\n- [ ] eggs\n\n> quoted\n\nx[^1]\n\n[^1]: a note\n\nend\n',
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
      '---\ntags:\n\n  - a\n---\n\n- body\n\nend\n',
    );
  });
});

/** Two loads: what the first save writes, and whether the second agrees. */
async function twoSaves(page: Page, variant: 'compat' | 'baseline', markdown: string) {
  const once = await roundTrip(page, variant, markdown);
  return { once, twice: await roundTrip(page, variant, once) };
}

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
    'an escaped <div> before bold': '\\<div> **b**\n',
    // `\[\[x]]` is the app's case, not this page's: the census page mounts no
    // wikilink plugin, so `[[x]]` needs no escape here. The shipped parser's
    // answer is a golden (tests/conformance/markdown-house-style.json).
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
    ['see <https://example.com/a\\.b> here\n', 'see https://example.com/a\\.b here\n'],
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
    'bold ending in a colon before a letter': '**Note:**&#x62;ar\n',
    'italic ending in a colon before a letter': '*Note:*&#x62;ar\n',
    'italic parentheses inside a word': '&#x61;*(b)*&#x63;\n',
    // CJK: bold ending in a full-width colon before the next ideograph.
    'CJK bold ending in a full-width colon': '**重要：**&#x8FD9;是\n',
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
  // its neighbours the way `*` does), and `mdast-util-gfm-strikethrough`'s
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
  // `_` run that could only flank encoded ignores a neighbouring or enclosing
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

test.describe('an attention run never invents a character reference (RC-104)', () => {
  // Milkdown trims a mark's edge spaces out of the mark and leaves the emptied
  // text node behind, so the first child of a link can be `''`. The remark-era
  // encoder compared the empty neighbour with the empty previous result and
  // wrote `&#xNAN;` into the note, on the first save of any note holding the
  // shape. None of these needs a reference at all.
  const SHAPES: Record<string, string> = {
    // the reported repro; the bold hoisted out of the link is upstream's own
    // re-spelling (the baseline writes the same links) and is not asserted away
    'a link over two bold runs and a bold-italic run': '[**a** ***b*** **c**](https://e.com/u)\n',
    'a link over a bold run and a bold-italic run': '[**a** ***b***](u)\n',
    'a link over a bold run and an underscore bold': '[**a** __b__ **c**](u)\n',
    'a link over a bold run then an italic whose edge is punctuation': '[**a** *:b*](u)\n',
    'a link that opens with a space then an underscore italic': '[ _a_](u)\n',
    'a link that opens and closes with a space around an underscore italic': '[ _a_ ](u)\n',
    'the same shape in a blockquote': '> [**a** ***b*** **c**](u)\n',
    'the same shape in a list item': '- [**a** ***b*** **c**](u)\n',
    'the same shape in a heading': '# [**a** ***b*** **c**](u)\n',
    'the same shape in a table cell': '| h |\n| --- |\n| [**a** ***b*** **c**](u) |\n',
  };

  for (const [name, markdown] of Object.entries(SHAPES)) {
    test(`compat writes no reference for ${name}`, async ({ page }) => {
      const { once, twice } = await twoSaves(page, 'compat', markdown);
      expect(once).not.toMatch(/&#/);
      expect(twice).not.toMatch(/&#|\\&/);
    });
  }

  test('a single character whose two edges both want encoding needs none', async ({ page }) => {
    // `x_a_y` is not emphasis; the entities make the intraword `_` run
    // reachable. The remark-era encoder cut a reference in two here
    // (`&#x61&#x3B;`), which reopened as text and gained a backslash. The house
    // style writes the italic with `*`, which opens and closes inside a word.
    const markdown = '&#x78;_a_&#x79;\n';
    const { once, twice } = await twoSaves(page, 'compat', markdown);
    expect(once).toBe('x*a*y\n');
    expect(twice).toBe(once);
  });
});

/**
 * A small seeded generator of inline markdown: text, punctuation and space
 * runs, bold / italic / strikethrough spelled every way, and links, nested to
 * depth three. Synthetic by construction — nothing here comes from a corpus.
 */
function inlineMarkdown(seed: number, depth = 0): string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const WORDS = ['a', 'b', 'Note', 'x9', 'é', '重要', '这是', '😀', '1'];
  const EDGES = [':', '(', ')', '，', '：', '.', '"', '!', '-', ' '];
  const MARKS = ['**', '*', '_', '__', '~~', '***', '___'];
  const run = (level: number): string => {
    let out = '';
    const count = 1 + Math.floor(next() * 4);
    for (let i = 0; i < count; i++) {
      const roll = next();
      if (roll < 0.28) out += pick(WORDS);
      else if (roll < 0.38) out += pick(EDGES);
      else if (roll < 0.5) out += ' ';
      else if (level >= 3) out += pick(WORDS);
      else if (roll < 0.85) {
        const mark = pick(MARKS);
        out += mark + run(level + 1) + mark;
      } else out += `[${run(level + 1)}](https://e.com/u)`;
    }
    return out;
  };
  return run(depth);
}

const CONTAINERS: Record<string, (inline: string) => string> = {
  paragraph: (x) => `${x}\n`,
  heading: (x) => `## ${x}\n`,
  blockquote: (x) => `> ${x}\n`,
  'bullet item': (x) => `- ${x}\n`,
  'ordered item': (x) => `1. ${x}\n`,
  'task item': (x) => `- [ ] ${x}\n`,
  'table cell': (x) => `| h |\n| --- |\n| ${x} |\n`,
  'link label': (x) => `[${x}](https://e.com/u)\n`,
  'image alt': (x) => `![${x}](p.png)\n`,
  'nested quote list': (x) => `> - ${x}\n`,
};

test.describe('random mark runs inside every container never gain a reference (RC-104)', () => {
  // 400, not 200: the house style writes a reference only where a parse says
  // flanking needs one, so it takes more draws to reach the encoder the
  // handful of times the check below asks for.
  const PER_CONTAINER = 400;

  for (const [name, wrap] of Object.entries(CONTAINERS)) {
    test(`compat: ${name}`, async ({ page }) => {
      const cases = Array.from({ length: PER_CONTAINER }, (_, i) =>
        wrap(inlineMarkdown(0x9e3779b1 * (i + 1) + name.length * 7919)),
      );
      const results = await page.evaluate(async (inputs) => {
        const load = window.__futoCensus.load;
        const out = [];
        for (const input of inputs) {
          const c1 = await load('compat', input);
          const c2 = await load('compat', c1.markdown);
          const b1 = await load('baseline', input);
          const b2 = await load('baseline', b1.markdown);
          out.push({
            input,
            saved: c1.markdown,
            docs: [c1.docJson, c2.docJson, b1.docJson, b2.docJson],
          });
        }
        return out;
      }, cases);

      // A tool's silence is not evidence: the generator has to reach the
      // encoder, or an all-green run proves nothing. (An image's alt text
      // keeps no marks, so it is the one container with nothing to encode.)
      if (name !== 'image alt') {
        expect(results.filter((r) => r.saved.includes('&#x')).length).toBeGreaterThan(5);
      }
      const inputChars = (input: string) => new Set(Array.from(input));
      for (const r of results) {
        // The generator writes no `&`: every `&` in a save is an encoding the
        // editor chose, and it must be a well-formed reference to a character
        // the note already had — never NaN, undefined, or a half-cut `&#x61`.
        const refs = r.saved.match(/&[^\s]{0,12}/g) ?? [];
        for (const ref of refs) {
          const ok = /^&#x[0-9A-F]{1,6};/.exec(ref);
          expect(
            ok,
            `malformed reference ${ref} saving ${JSON.stringify(r.input)} as ${JSON.stringify(r.saved)}`,
          ).not.toBeNull();
          const char = String.fromCodePoint(parseInt((ok as RegExpExecArray)[0].slice(3, -1), 16));
          expect(
            inputChars(r.input).has(char),
            `reference to a character the note never had in ${JSON.stringify(r.saved)}`,
          ).toBe(true);
        }
        expect(r.saved).not.toMatch(/NaN|undefined/);
        // parse(serialize(doc)) equals doc — at least whenever the unpatched
        // preset manages it, so the assertion is about what THIS layer adds.
        // Compared with only a mark's `*`/`_` marker taken out
        // (`withoutMarkers`): it is how the file spelled the run, which the
        // house style does not remember. Nothing else is forgiven.
        const [c1, c2, b1, b2] = r.docs.map(withoutMarkers);
        if (b1 === b2) {
          expect(
            c2,
            `the document changed on reopen: ${JSON.stringify(r.input)} saved as ${JSON.stringify(r.saved)}`,
          ).toBe(c1);
        }
      }
    });
  }
});
