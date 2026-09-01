import { test, expect, Page } from '@playwright/test';

import { EDITOR, openNewNote, setEditorMarkdown } from './lib/desktopEditor';

/**
 * Wikilinks on the DESKTOP shell.
 *
 * What a wikilink renders as, how it resolves, when it is broken, and how the
 * `[[` suggestion popup behaves are all covered against the real shipped
 * bundle in `tests/editor-embed-milkdown-wikilinks.spec.ts` (29 cases). This
 * file keeps only what is specific to the desktop shell: the note universe
 * comes from `notesCache` rather than a host `setNotes` call, and a click has
 * to move the app's own route.
 *
 * Deleted with the CodeMirror engine, along with the spec lines they locked:
 * `wikilink brackets are hidden when blurred` and `wikilink shows raw syntax
 * when cursor is on the line` (marker reveal — a WYSIWYG link has no brackets
 * to hide or reveal); the two click-to-the-right-of-a-wikilink cases and
 * `triple clicking a plain line above a wikilink selects only that line`
 * (`interactions/**` is gone, so caret placement is the platform's own); and
 * the `data-wikilink` / code-block / empty-`[[]]` decoration cases plus three
 * autocomplete cases, all of which the embed suite already asserts against the
 * same editor.
 */

async function seedNote(page: Page, content: string): Promise<void> {
  await openNewNote(page);
  await setEditorMarkdown(page, content);
}

async function blurEditor(page: Page): Promise<void> {
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(300);
}

async function injectTestNotes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.__testNotes?._injectTestNote) {
      w.__testNotes._injectTestNote('grocery list', 'grocery list');
      w.__testNotes._injectTestNote('meeting notes', 'meeting notes');
      w.__testNotes._injectTestNote('project ideas', 'project ideas');
    }
  });
}

test.describe('Wikilinks on desktop', () => {
  test('a link re-renders when the note universe changes', async ({ page }) => {
    await seedNote(page, 'See [[future note]] here.\n\nMore text');
    await blurEditor(page);
    await expect(page.locator('.cm-md-wikilink-broken')).toBeVisible();

    await page.evaluate(() => {
      (window as any).__testNotes?._injectTestNote('future note', 'body');
    });

    await expect(page.locator('.cm-md-wikilink-broken')).toHaveCount(0);
    await expect(page.locator('.cm-md-wikilink')).toHaveText('future note');
  });

  test('clicking a wikilink navigates to the note URL', async ({ page }) => {
    await seedNote(page, 'See [[some target note]] for info.\n\nMore text');
    await blurEditor(page);

    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toBeVisible();

    await wikilink.click();

    await expect(page).toHaveURL(/some%20target%20note/, { timeout: 5000 });
  });

  test('typing `[[` suggests notes from the desktop note cache', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!(window as any).__testNotes, null, { timeout: 15000 });
    await injectTestNotes(page);

    expect(
      await page.evaluate(() => (window as any).__testNotes?.getAllNotes?.()?.length ?? 0),
    ).toBeGreaterThanOrEqual(3);

    await openNewNote(page);
    await page.locator(EDITOR).click();
    await page.keyboard.type('[[', { delay: 100 });

    const popup = page.locator('.futo-wikilink-suggest');
    await expect(popup).toBeVisible({ timeout: 3000 });
    await expect(popup).toContainText('grocery list');
  });
});
