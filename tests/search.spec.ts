import { test, expect, Page } from '@playwright/test';

/** Create a note by calling the notes API directly (bypasses the web FS stub). */
async function createTestNote(page: Page, title: string, body: string): Promise<void> {
  await page.evaluate(
    async ({ title, body }) => {
      const api = (window as any).__testNotes;
      if (!api) throw new Error('__testNotes not available — is dev mode running?');
      await api.createNote(title, body);
    },
    { title, body },
  );
}

/** Wait for the app to be initialized and the test bridge to be available. */
async function waitForApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!(window as any).__testNotes, null, { timeout: 10000 });
}

test.describe('Search', () => {
  test('search returns results and filters by query', async ({ page }) => {
    await waitForApp(page);

    await createTestNote(page, 'Apple Pie Recipe', 'Mix flour and sugar with apples');
    await createTestNote(page, 'Grocery List', 'Eggs milk bread');

    await page.locator('.search-button').click();
    await page.waitForSelector('.search-overlay', { timeout: 5000 });

    const input = page.locator('.search-input');
    await input.fill('apple');

    const results = page.locator('.search-result-item');
    await expect(results).toHaveCount(1, { timeout: 5000 });
    await expect(results.first().locator('.search-result-title')).toContainText('Apple Pie Recipe');
  });

  test('empty query shows all notes', async ({ page }) => {
    await waitForApp(page);

    await createTestNote(page, 'Note One', 'First content');
    await createTestNote(page, 'Note Two', 'Second content');

    await page.locator('.search-button').click();
    await page.waitForSelector('.search-overlay', { timeout: 5000 });

    const results = page.locator('.search-result-item');
    await expect(results).toHaveCount(2, { timeout: 5000 });
  });

  test('Escape closes search popup', async ({ page }) => {
    await waitForApp(page);

    await page.locator('.search-button').click();
    await page.waitForSelector('.search-overlay', { timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(page.locator('.search-overlay')).toHaveCount(0);
  });

  test('keyboard navigation: ArrowDown/ArrowUp/Enter', async ({ page }) => {
    await waitForApp(page);

    await createTestNote(page, 'First Note', 'Content for first');
    await createTestNote(page, 'Second Note', 'Content for second');

    await page.locator('.search-button').click();
    await page.waitForSelector('.search-overlay', { timeout: 5000 });

    // All notes shown (empty query)
    const results = page.locator('.search-result-item');
    await expect(results).toHaveCount(2, { timeout: 5000 });

    // Arrow down to select first result
    await page.keyboard.press('ArrowDown');
    await expect(results.first()).toHaveClass(/selected/);

    // Arrow down to second
    await page.keyboard.press('ArrowDown');
    await expect(results.nth(1)).toHaveClass(/selected/);

    // Arrow up back to first
    await page.keyboard.press('ArrowUp');
    await expect(results.first()).toHaveClass(/selected/);

    // Enter to select
    await page.keyboard.press('Enter');
    // Should navigate away from search (popup closes)
    await expect(page.locator('.search-overlay')).toHaveCount(0);
  });

  test('search snippet shows matched term context with highlight', async ({ page }) => {
    await waitForApp(page);

    await createTestNote(
      page,
      'Long Document',
      'This is filler text before the important keyword specialterm appears somewhere in the middle of the content.'
    );

    await page.locator('.search-button').click();
    await page.waitForSelector('.search-overlay', { timeout: 5000 });

    const input = page.locator('.search-input');
    await input.fill('specialterm');

    const results = page.locator('.search-result-item');
    await expect(results).toHaveCount(1, { timeout: 5000 });

    // The snippet should contain a highlighted mark element
    const mark = results.first().locator('.search-highlight');
    await expect(mark).toHaveCount(1, { timeout: 5000 });
    await expect(mark).toContainText('specialterm');
  });
});
