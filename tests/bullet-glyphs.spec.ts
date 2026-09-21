import { test, expect } from '@playwright/test';

import {
  EDITOR,
  openNewNote,
  setEditorMarkdown,
  typeAtCaret,
  typeInEditor,
} from './lib/desktopEditor';

/**
 * List markers and the hanging indent, measured in a real browser.
 *
 * The editor renders a list as a real `<ul>`/`<ol>`, so the marker column and
 * the wrap are the browser's own list layout rather than a decoration the
 * editor paints. That is what makes these assertions worth having: they check
 * the CSS in `MilkdownEditor.svelte` actually produces the geometry
 * docs/spec/editor.md claims, at every nesting depth.
 *
 * What is NOT here any more: the CodeMirror editor replaced each `- ` marker
 * with a widget whose glyph cycled •/◦/▪ by depth, and revealed the raw `- `
 * again on the line holding the caret. Both were decorations over markdown
 * source. A real `<ul>` has neither, so the glyph-cycle test and the
 * decorated-vs-revealed indent-shift test were deleted with the engine; the
 * lost glyph cycle is recorded as a Gap in docs/spec/editor.md.
 *
 * Pixel measurements, so these only mean anything in a real browser.
 */

const NESTED = ['- L0', '  - L1', '    - L2', '      - L3', ''].join('\n');

test.describe('List markers and hanging indent', () => {
  test('every nesting level renders a marker', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(() => document.fonts.ready);
    await setEditorMarkdown(page, NESTED);

    // Four items, each in its own list, nested four deep.
    await expect(page.locator(`${EDITOR} li`)).toHaveCount(4);

    // `list-style: disc` on every `ul`, so each item paints a marker in its own
    // marker box rather than inheriting the browser's depth cycle. Asserted
    // through the computed style because a `::marker` has no box of its own to
    // measure.
    const markers = await page.evaluate(
      (selector) =>
        [...document.querySelectorAll(`${selector} li`)].map(
          (item) => getComputedStyle(item).listStyleType,
        ),
      EDITOR,
    );
    expect(markers).toEqual(['disc', 'disc', 'disc', 'disc']);
  });

  test('each level indents further than the one above it', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(() => document.fonts.ready);
    await setEditorMarkdown(page, NESTED);

    const lefts = await page.evaluate(
      (selector) =>
        [...document.querySelectorAll(`${selector} li > p`)].map(
          (paragraph) => paragraph.getBoundingClientRect().left,
        ),
      EDITOR,
    );

    expect(lefts).toHaveLength(4);
    for (let depth = 1; depth < lefts.length; depth += 1) {
      expect(lefts[depth], `level ${depth} indent over level ${depth - 1}`).toBeGreaterThan(
        lefts[depth - 1],
      );
    }
  });

  /**
   * The spec's hanging-indent claim: a wrapped row starts under the item's
   * TEXT, not back under its marker. Measured on a deliberately narrow viewport
   * so the item is forced to wrap, and at depth 2 so a regression that only
   * hangs the top level still fails.
   */
  test('a wrapped item hangs its continuation rows under its own text', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 900 });
    await openNewNote(page);
    await page.evaluate(() => document.fonts.ready);
    await setEditorMarkdown(
      page,
      ['- top', `  - ${'wrapping words '.repeat(30).trim()}`, ''].join('\n'),
    );

    const rows = await page.evaluate((selector) => {
      const paragraph = document.querySelectorAll(`${selector} li > p`)[1];
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      // A visual row can produce SEVERAL client rects — the text run, plus a
      // few-pixel sliver for the trailing space. Group by `top` and take each
      // row's leftmost edge, which is the one the hang is about.
      const leftByRow = new Map<number, number>();
      for (const rect of range.getClientRects()) {
        const row = Math.round(rect.top);
        const left = Math.round(rect.left);
        leftByRow.set(row, Math.min(leftByRow.get(row) ?? left, left));
      }
      return [...leftByRow.entries()].sort((a, b) => a[0] - b[0]).map(([, left]) => left);
    }, EDITOR);

    expect(rows.length, 'the item must actually wrap for this to mean anything').toBeGreaterThan(1);
    // Every row shares the first row's left edge: that IS the hang. A marker
    // column reclaimed by the wrap would put later rows further left.
    for (const [index, left] of rows.entries()) {
      expect(left, `wrapped row ${index}`).toBe(rows[0]);
    }
  });

  test('Tab nests the item under the one above it', async ({ page }) => {
    await openNewNote(page);

    await typeInEditor(page, '- parent');
    await page.keyboard.press('Enter');
    // List continuation carries the marker, so only the content is typed.
    await typeAtCaret(page, 'child');
    await page.keyboard.press('Tab');

    // The nesting is what Tab means — asserted on the document, not on a glyph.
    await expect(page.locator(`${EDITOR} li li`)).toHaveCount(1);
    await expect(page.locator(`${EDITOR} li li`)).toContainText('child');
  });
});
