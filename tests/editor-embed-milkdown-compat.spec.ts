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
 * are gone, and the empty-paragraph placeholder machinery upstream's plugin
 * exists for still works.
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

test.describe('the empty-paragraph placeholder still round-trips', () => {
  // Upstream's plugin exists for this, and the fixed copy has to keep doing it:
  // registering the replacement under a different slice name would silently
  // turn the serializer half off and start dropping the author's blank lines.
  const CASES: Record<string, string> = {
    'a blank line between paragraphs': 'para one\n\n<br />\n\npara two\n',
    'an empty table cell': '| a | b |\n| --- | --- |\n| <br /> | x |\n',
    'an empty list item': '- a\n- <br />\n- b\n',
    'an empty blockquote line': '> <br />\n',
    'an empty footnote definition': 'ref[^4]\n\n[^4]: <br />\n',
  };

  for (const [name, markdown] of Object.entries(CASES)) {
    test(`compat preserves ${name}`, async ({ page }) => {
      const compat = await roundTrip(page, 'compat', markdown);
      const baseline = await roundTrip(page, 'baseline', markdown);
      expect(compat).toContain('<br />');
      // Byte-for-byte the same as upstream: this behavior is not being changed.
      expect(compat).toBe(baseline);
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

test.describe('numbered-looking bullets stay text', () => {
  const BULLETS = '* 0. item one\n* 1. item two\n';

  test('canary: upstream injects a literal <br /> and a nested list', async ({ page }) => {
    const out = await roundTrip(page, 'baseline', BULLETS);
    expect(out).toContain('<br />');
    expect(out).toContain('  0. item one');
  });

  test('compat escapes the digit-dot instead', async ({ page }) => {
    const out = await roundTrip(page, 'compat', BULLETS);
    expect(out).not.toContain('<br />');
    expect(out).toContain('0\\. item one');
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
