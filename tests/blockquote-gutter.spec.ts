import { test, expect, Page } from '@playwright/test';

/**
 * Blockquote geometry: each `>` marker occupies a FIXED-WIDTH gutter, so a
 * line's content x-position depends only on its nesting depth — never on how
 * many characters the marker happened to be ("> " vs ">"), and never on whether
 * the marker is currently revealed under the caret. That part holds at ANY
 * depth, which is why the document below nests to 5.
 *
 * The per-level INDENT does not: only levels 1-3 have a rule in
 * markdown-blocks.css, so depth >= 4 falls back to the depth-1 indent and a
 * single stripe. That is a recorded gap (docs/spec/editor.md), so the indent
 * assertions below stop at depth 3 — exactly where the spec's claim stops.
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
  '> > > > Delta', // 8 - depth 4
  '>>>>Delta', // 9 - depth 4
  '> > > > > Echo', // 10 - depth 5
  '>>>>>Echo', // 11 - depth 5
  '', // 12 - caret parks here
];
const DOC = LINES.join('\n');
const PLAIN = 0;
const QUOTE_LINES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const SAME_DEPTH_PAIRS: Array<[number, number]> = [
  [2, 3],
  [4, 5],
  [6, 7],
  [8, 9],
  [10, 11],
];
/** Representative (spaced-marker) line for each nesting depth. */
const DEPTH_LINE: Record<number, number> = { 1: 2, 2: 4, 3: 6, 4: 8, 5: 10 };

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
        const match = (node.textContent ?? '').match(/Plain|Alpha|Bravo|Charlie|Delta|Echo/);
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

/**
 * Per quote line: its padding-left, how many stripe layers it paints, and where
 * each stripe's left edge sits. The indent lives on the line box, so this is
 * what the per-level rules control — and the offsets are what make the spec's
 * "left edge of each 15px step" claim falsifiable.
 */
async function quoteLineIndents(
  page: Page,
): Promise<Array<{ padding: number; stripes: number; stripeOffsets: number[] }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-line')).map((line) => {
      const style = getComputedStyle(line);
      // One gradient layer per stripe. Counting `gradient(` rather than
      // splitting on commas, which also separate a gradient's own colour stops.
      const stripes = (style.backgroundImage.match(/gradient\(/g) ?? []).length;
      // backgroundPosition has no nested commas, so splitting is safe here:
      // "0px 0px, 15px 0px" -> [0, 15].
      const stripeOffsets = style.backgroundPosition
        .split(',')
        .map((pair) => Number.parseFloat(pair.trim().split(/\s+/)[0]));
      return { padding: Number.parseFloat(style.paddingLeft), stripes, stripeOffsets };
    }),
  );
}

test.describe('Blockquote marker gutter', () => {
  test('content x is independent of marker text at every depth', async ({ page }) => {
    await openNewNote(page);
    await setDoc(page, DOC);

    const lefts = await contentLefts(page);
    expect(lefts).toHaveLength(LINES.length);
    for (const line of [PLAIN, ...QUOTE_LINES]) expect(lefts[line]).toBeGreaterThan(0);

    for (const [spaced, tight] of SAME_DEPTH_PAIRS) {
      expect(
        Math.abs(lefts[spaced] - lefts[tight]),
        `lines ${spaced}/${tight} (${LINES[spaced]} vs ${LINES[tight]})`,
      ).toBeLessThan(0.5);
    }
  });

  test('depths 1-3 each add one constant indent step and one more stripe', async ({ page }) => {
    await openNewNote(page);
    await setDoc(page, DOC);

    const lefts = await contentLefts(page);
    const step = lefts[DEPTH_LINE[1]] - lefts[PLAIN];
    expect(step).toBeGreaterThan(0);
    for (const depth of [2, 3]) {
      expect(
        Math.abs(lefts[DEPTH_LINE[depth]] - lefts[DEPTH_LINE[depth - 1]] - step),
        `depth ${depth} (${LINES[DEPTH_LINE[depth]]}) step over depth ${depth - 1}`,
      ).toBeLessThan(0.5);
    }

    // The step is the line's own indent (15px per level) plus that level's
    // marker gutter, and each level paints one more stripe — at the left edge
    // of its 15px step (0px, 15px, 30px), not against the content.
    const indents = await quoteLineIndents(page);
    for (const depth of [1, 2, 3]) {
      const line = DEPTH_LINE[depth];
      expect(indents[line].padding, `depth ${depth} padding-left`).toBeCloseTo(15 * depth, 1);
      expect(indents[line].stripes, `depth ${depth} stripe count`).toBe(depth);
      expect(indents[line].stripeOffsets, `depth ${depth} stripe offsets`).toEqual(
        Array.from({ length: depth }, (_, i) => 15 * i),
      );
    }
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
