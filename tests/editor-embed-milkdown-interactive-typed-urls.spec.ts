// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect, type Page } from '@playwright/test';
import {
  test,
  reopen,
  paragraphLines,
  renderedMarks,
  typeIntoEmpty,
} from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// A delimiter typed inside a URL is the URL's own character, as a file reads
// it (spec: interactive-elements.md "A delimiter typed inside a URL"): a GFM
// autolink literal runs on to the next whitespace and trims only a trailing
// delimiter.
// ============================================================

for (const [typed, linked] of [
  ['https://x.test/*a* ok', 'https://x.test/*a'],
  ['see www.x.test/_a_ ok', 'www.x.test/_a'],
] as const) {
  test(`delimiters typed inside a URL stay part of it: "${typed}"`, async ({ page }) => {
    // A file reads the `*`/`_` inside a URL as the URL's own characters (GFM
    // trims only the trailing one), never as emphasis.
    const saved = await typeIntoEmpty(page, typed);
    expect(saved).toBe(`${typed}\n`);
    expect(await renderedMarks(page), saved).toEqual([]);
    const href = linked.startsWith('www.') ? `http://${linked}` : linked;
    const links = () =>
      page
        .locator('.ProseMirror a')
        .evaluateAll((as) => as.map((a) => [a.textContent ?? '', a.getAttribute('href') ?? '']));
    expect(await links(), saved).toEqual([[linked, href]]);
    await reopen(page, saved);
    expect(await links(), saved).toEqual([[linked, href]]);
  });
}

/** Each rendered link as [text, href]. */
function renderedLinks(page: Page): Promise<string[][]> {
  return page
    .locator('.ProseMirror a')
    .evaluateAll((as) => as.map((a) => [a.textContent ?? '', a.getAttribute('href') ?? '']));
}

for (const [typed, linked] of [
  ['x *b https://x.test/a*b ok', 'https://x.test/a*b'],
  ['x _b https://x.test/a_b ok', 'https://x.test/a_b'],
  ['x **b https://x.test/a**b ok', 'https://x.test/a**b'],
  ['x ~~b https://x.test/a~~b ok', 'https://x.test/a~~b'],
  ['x *b www.x.test/a*b ok', 'www.x.test/a*b'],
] as const) {
  test(`a closer typed inside a URL stays part of it: "${typed}"`, async ({ page }) => {
    // #273: the URL runs on past the delimiter, so a file reads it as the
    // URL's own character and the opener before the URL closes nothing.
    const saved = await typeIntoEmpty(page, typed);
    const href = linked.startsWith('www.') ? `http://${linked}` : linked;
    expect(await renderedMarks(page), saved).toEqual([]);
    expect(await renderedLinks(page), saved).toEqual([[linked, href]]);
    await reopen(page, saved);
    expect(await paragraphLines(page), saved).toEqual([typed]);
    expect(await renderedMarks(page), saved).toEqual([]);
    expect(await renderedLinks(page), saved).toEqual([[linked, href]]);
  });
}

for (const [typed, mark, written] of [
  ['x *b https://x.test/a* ok', 'em', 'x *b https://x.test/a* ok'],
  // The house style writes emphasis with `*`.
  ['x _b https://x.test/a_ ok', 'em', 'x *b https://x.test/a* ok'],
  ['x **b https://x.test/a** ok', 'strong', 'x **b https://x.test/a** ok'],
  ['x ~~b https://x.test/a~~ ok', 'del', 'x ~~b https://x.test/a~~ ok'],
] as const) {
  test(`a closer that ends a URL still converts: "${typed}"`, async ({ page }) => {
    // The space after the closer ends the URL, and GFM trims a trailing
    // delimiter off a literal, so a file reads the run as closing the opener.
    // A link splits a strikethrough into one element on each side of it.
    const marked = async () =>
      (await page.locator(`.ProseMirror p ${mark}`).allTextContents()).join('');
    const saved = await typeIntoEmpty(page, typed);
    expect(saved).toBe(`${written}\n`);
    expect(await marked(), saved).toBe('b https://x.test/a');
    expect(await renderedLinks(page), saved).toEqual([['https://x.test/a', 'https://x.test/a']]);
    await reopen(page, saved);
    expect(await marked(), saved).toBe('b https://x.test/a');
  });
}

test('a backtick typed after a URL still closes a code span', async ({ page }) => {
  // A code span outranks an autolink literal, as a file reads it.
  const saved = await typeIntoEmpty(page, 'x `b https://x.test/a`b ok');
  expect(await renderedMarks(page), saved).toEqual(['code:b https://x.test/a']);
});
