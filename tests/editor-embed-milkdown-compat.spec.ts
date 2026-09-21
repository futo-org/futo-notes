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
  // Fixed points of the census harness's serializer. Where the input ends on a
  // block that is not a paragraph, the trailing blank line is Milkdown's
  // `trailing` plugin parking its end-of-document paragraph — pre-existing and
  // unrelated to this rule — and `*`/`| - |` are remark-stringify's defaults
  // (the app sets `bullet: '-'` in its own config, the harness does not).
  const STABLE: Record<string, string> = {
    'two blank lines between paragraphs': 'para one\n\n\npara two\n',
    'three blank lines between paragraphs': 'para one\n\n\n\npara two\n',
    'blank lines before the first block': '\n\npara\n',
    'two blank lines inside a blockquote': '> a\n>\n>\n> b\n\n',
    'two blank lines inside a list item': '* a\n\n\n  b\n* c\n\n',
    'an empty list item': '* a\n*\n* b\n\n',
    // The schema puts an empty paragraph in front of an item whose only content
    // is a block; that filler is not the note's and is not written
    // (packages/editor/src/milkdown-compat/listItemFiller.ts). Without that,
    // these save as a bare `*` over an indented block, and the NEXT save escapes
    // it to a literal `\*` — 60 census notes.
    'a list item holding only a blockquote': '* > quote\n* b\n\n',
    'a list item holding only a heading': '* # heading\n\n',
    'a list item holding only a nested list': '* * nested\n  * deeper\n\n',
    // Two lists with a gap between them: the second list alternates its marker
    // as if adjacent, or CommonMark would read the pair back as ONE list.
    'two bullet lists with a blank line between them': '* a\n\n\n- b\n\n',
    'two ordered lists with a blank line between them': '1. a\n\n\n1) b\n\n',
    'an empty table cell': '| a | b |\n| - | - |\n|   | x |\n\n',
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
      '| a | b |\n| - | - |\n|   | x |\n\n',
    ],
    'an empty list item': ['- a\n- <br />\n- b\n', '* a\n*\n* b\n\n'],
    'an empty blockquote line': ['> <br />\n', '>\n\n'],
    'an empty footnote definition': ['ref[^4]\n\n[^4]: <br />\n', 'ref[^4]\n\n[^4]: \n\n'],
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

  test('compat keeps the fences on a note with no body at all', async ({ page }) => {
    // The one shape that is not byte-identical, and it is the accepted
    // normalize-once class rather than a front matter defect: the doc's content
    // expression is `frontmatter? block+`, so a document parsed as nothing but
    // front matter gets ProseMirror's required empty paragraph filled in, and
    // that serializes as one trailing blank line. Keeping the fill is the
    // deliberate trade — without it the only selection such a note admits is a
    // node selection ON the front matter, and the next keystroke would replace
    // the metadata. Opening still hands back the host's own bytes (the
    // load-echo guard); this is only what a real edit writes.
    const out = await roundTrip(page, 'compat', '---\na: 1\n---\n');
    expect(out).toBe('---\na: 1\n---\n\n');
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
});
