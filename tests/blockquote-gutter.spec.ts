import { test, expect, Page } from '@playwright/test';

/**
 * Blockquote geometry: each `>` marker occupies a FIXED-WIDTH gutter, so a
 * line's content x-position depends only on its nesting depth — never on how
 * many characters the marker happened to be ("> " vs ">"), and never on whether
 * the marker is currently revealed under the caret.
 *
 * These are pixel measurements, so they only mean anything in a real browser
 * (jsdom has no layout).
 */

const LINES = [
  'Plain', // 0 - unquoted baseline
  '', // 1
  '> Alpha', // 2 - depth 1, marker "> "
  '>Alpha', // 3 - depth 1, marker ">"
  '> > Bravo', // 4 - depth 2
  '>>Bravo', // 5 - depth 2
  '> > > Charlie', // 6 - depth 3
  '>>>Charlie', // 7 - depth 3
  '', // 8 - caret parks here
];
const DOC = LINES.join('\n');
const PLAIN = 0;
const QUOTE_LINES = [2, 3, 4, 5, 6, 7];
const SAME_DEPTH_PAIRS: Array<[number, number]> = [
  [2, 3],
  [4, 5],
  [6, 7],
];

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  // Custom fonts change glyph advances, so measurements are only stable once
  // they have loaded.
  await page.evaluate(() => document.fonts.ready);
}

async function setDoc(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const view = (window as { __cmGetView?: () => unknown }).__cmGetView?.() as {
      state: { doc: { length: number } };
      dispatch: (spec: unknown) => void;
    } | null;
    if (!view) throw new Error('no editor view');
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: value.length },
    });
  }, text);
  await page.waitForTimeout(200);
}

/**
 * Left edge (px) of the first content character of each rendered line, indexed
 * by line. Measuring the glyph itself — rather than the line box — is what
 * makes the marker's own width visible to the assertion. `-1` = no content.
 */
async function contentLefts(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line')).map((line) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node) {
        const match = (node.textContent ?? '').match(/Plain|Alpha|Bravo|Charlie/);
        if (match && match.index !== undefined) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + 1);
          return range.getBoundingClientRect().left;
        }
        node = walker.nextNode() as Text | null;
      }
      return -1;
    }),
  );
}

test.describe('Blockquote marker gutter', () => {
  test('content x is independent of marker text and constant per depth', async ({ page }) => {
    await openNewNote(page);
    await setDoc(page, DOC);

    const lefts = await contentLefts(page);
    expect(lefts).toHaveLength(LINES.length);
    for (const line of [PLAIN, ...QUOTE_LINES]) expect(lefts[line]).toBeGreaterThan(0);

    // (a) "> x" and ">x" at the same depth start at the same x.
    for (const [spaced, tight] of SAME_DEPTH_PAIRS) {
      expect(
        Math.abs(lefts[spaced] - lefts[tight]),
        `lines ${spaced}/${tight} (${LINES[spaced]} vs ${LINES[tight]})`,
      ).toBeLessThan(0.5);
    }

    // (b) each extra depth adds the same gutter.
    const gutter = lefts[2] - lefts[PLAIN];
    expect(gutter).toBeGreaterThan(0);
    expect(Math.abs(lefts[4] - lefts[2] - gutter)).toBeLessThan(0.5);
    expect(Math.abs(lefts[6] - lefts[4] - gutter)).toBeLessThan(0.5);
  });

  test('revealing the marker under the caret does not move content', async ({ page }) => {
    await openNewNote(page);
    await setDoc(page, DOC);

    const before = await contentLefts(page);

    for (const line of QUOTE_LINES) {
      await page.locator('.cm-line').nth(line).click();
      await page.waitForTimeout(150);

      // Guard against a silent pass: the caret must actually have revealed the
      // markers, otherwise there is no shift to detect in the first place.
      const revealed = await page.locator('.cm-md-quote-marker').count();
      expect(revealed, `line ${line} (${LINES[line]}) revealed markers`).toBeGreaterThan(0);

      const after = await contentLefts(page);
      expect(
        Math.abs(after[line] - before[line]),
        `line ${line} (${LINES[line]}) shifted on reveal`,
      ).toBeLessThan(0.5);
    }
  });
});
