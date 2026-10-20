// Part of the Milkdown compat suite: the round-trip contract is described in
// editor-embed-milkdown-compat.spec.ts.

import { expect, test, type Page } from '@playwright/test';
import { useCensusPage, roundTrip, twoSaves } from './lib/editorEmbedMilkdownCompat';

useCensusPage();

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
      '---\n\nShopping\n\n- milk\n  - skim\n- [ ] eggs\n\n> quoted\n\nx[^1]\n\n[^1]: a note\n\nend\n',
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
