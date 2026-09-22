import { expect, test } from '@playwright/test';

import { EDITOR, openNewNote, setEditorMarkdown, TYPE_DELAY_MS } from './lib/desktopEditor';

/**
 * QA-018: typing `---` mid-note scroll-jumped the editor upward.
 *
 * Root cause: `@milkdown/preset-commonmark`'s `---` input rule left a
 * NodeSelection ON THE HR ITSELF whenever nothing usable already followed it
 * — an empty line is exactly that. A NodeSelection on a block atom is what a
 * browser's native "scroll selection into view" reacts to: the rule renders
 * where the caret already was, but the selection is now the hr, not a text
 * caret, and centering "the hr" nudges the viewport. The fix
 * (`dividerCaret.ts`) normalizes the selection to a TextSelection in the
 * empty paragraph right after the rule — the same end state the `/divider`
 * slash item lands in (`slash-menu.spec.ts`), never a NodeSelection.
 *
 * A unit test cannot see a scroll jump, so this drives the real desktop shell:
 * scroll a long note so the typing point sits mid-viewport, type `---` there,
 * and assert the reader's view of the note does not move.
 */

const LONG_NOTE = [
  'FIRST LINE',
  ...Array.from(
    { length: 80 },
    (_, i) => `Paragraph ${i + 1} of a note that is much taller than the window.`,
  ),
  'TARGET LINE',
  ...Array.from(
    { length: 20 },
    (_, i) => `Paragraph ${i + 81} of a note that is much taller than the window.`,
  ),
].join('\n\n');

test.describe('typing --- does not scroll-jump the editor (QA-018)', () => {
  test('the note does not move when a divider is created mid-note', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, LONG_NOTE);

    const target = page.locator(EDITOR).locator('p', { hasText: 'TARGET LINE' }).first();
    await target.scrollIntoViewIfNeeded();
    // The note streams in over idle time (progressiveLoad.ts) — wait for the
    // WHOLE thing so the note is already at its full scrollable height before
    // measuring anything.
    await expect(page.locator(EDITOR).locator('p', { hasText: 'Paragraph 100 of' })).toHaveCount(1);
    await expect(target).toBeInViewport();

    // Caret at the end of the target line, then Enter for a fresh empty
    // paragraph right there — mid-viewport, exactly where a real edit happens.
    await target.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    const firstLineBefore = await page
      .locator(EDITOR)
      .locator('p', { hasText: 'FIRST LINE' })
      .first()
      .boundingBox();
    expect(firstLineBefore).not.toBeNull();

    await page.keyboard.type('---', { delay: TYPE_DELAY_MS });
    await expect(page.locator(`${EDITOR} hr`)).toHaveCount(1);

    // The reader's view of the note — anchored on a line far from the edit —
    // must not have moved. `toBeInViewport` alone would pass even after a
    // large jump that happens to leave the line barely visible; comparing
    // the exact position is the assertion that actually catches QA-018.
    const firstLineAfter = await page
      .locator(EDITOR)
      .locator('p', { hasText: 'FIRST LINE' })
      .first()
      .boundingBox();
    expect(firstLineAfter).not.toBeNull();
    expect(firstLineAfter!.y).toBeCloseTo(firstLineBefore!.y, 0);
  });
});
