import { test, expect, Page } from '@playwright/test';

async function setupEditor(page: Page, content: string): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });

  const editor = page.locator('.cm-content');
  await editor.click();
  await editor.fill(content);
  await page.keyboard.press('Control+End');
  await page.waitForTimeout(200);
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

// ============================================================================
// DECORATION TESTS
// ============================================================================

test.describe('Wikilink Decorations', () => {
  test('wikilink renders with dashed underline when blurred', async ({ page }) => {
    await setupEditor(page, 'Check [[my note]] here.\n\nMore text');
    await blurEditor(page);

    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toBeVisible();
    await expect(wikilink).toHaveText('my note');

    const decoStyle = await wikilink.evaluate(el =>
      window.getComputedStyle(el).textDecorationStyle
    );
    expect(decoStyle).toBe('dashed');
  });

  test('wikilink brackets are hidden when blurred', async ({ page }) => {
    await setupEditor(page, 'Check [[my note]] here.\n\nMore text');
    await blurEditor(page);

    const visibleText = await page.locator('.cm-content').evaluate(
      (el) => (el as HTMLElement).innerText
    );
    expect(visibleText).toContain('my note');
    expect(visibleText).not.toContain('[[');
    expect(visibleText).not.toContain(']]');
  });

  test('wikilink shows raw syntax when cursor is on the line', async ({ page }) => {
    await setupEditor(page, '[[my note]]');
    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toHaveCount(0);
  });

  test('wikilink has data-wikilink attribute', async ({ page }) => {
    await setupEditor(page, 'See [[grocery list]] for details.\n\nMore text');
    await blurEditor(page);

    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toBeVisible();
    const attr = await wikilink.getAttribute('data-wikilink');
    expect(attr).toBe('grocery list');
  });

  test('wikilink inside code block is not decorated', async ({ page }) => {
    await setupEditor(page, '```\n[[not a link]]\n```\n\nMore text');
    await blurEditor(page);

    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toHaveCount(0);
  });

  test('empty wikilink [[]] is not decorated', async ({ page }) => {
    await setupEditor(page, 'Empty [[]] here.\n\nMore text');
    await blurEditor(page);

    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toHaveCount(0);
  });
});

// ============================================================================
// CLICK NAVIGATION TESTS
// ============================================================================

test.describe('Wikilink Navigation', () => {
  test('clicking wikilink navigates to note URL', async ({ page }) => {
    await setupEditor(page, 'See [[some target note]] for info.\n\nMore text');
    await blurEditor(page);

    const wikilink = page.locator('.cm-md-wikilink');
    await expect(wikilink).toBeVisible();

    await wikilink.click();
    await page.waitForTimeout(500);

    const url = page.url();
    expect(url).toContain('some%20target%20note');
  });
});

// ============================================================================
// AUTOCOMPLETE TESTS
// ============================================================================

test.describe('Wikilink Autocomplete', () => {
  test('autocomplete popup appears when typing [[ with notes in cache', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    // Inject test notes into the in-memory cache
    await injectTestNotes(page);

    // Verify injection worked
    const noteCount = await page.evaluate(() => {
      const w = window as any;
      return w.__testNotes?.getAllNotes?.()?.length ?? 0;
    });
    expect(noteCount).toBeGreaterThanOrEqual(3);

    // Navigate to new note
    await page.goto('/#/note/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.cm-content', { timeout: 10000 });

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.waitForTimeout(200);

    // Type [[ character by character
    await page.keyboard.type('[[', { delay: 100 });
    await page.waitForTimeout(500);

    // Autocomplete tooltip should appear
    const tooltip = page.locator('.cm-tooltip-autocomplete');
    await expect(tooltip).toBeVisible({ timeout: 2000 });

    // Should show our injected notes
    const optionText = await tooltip.innerText();
    expect(optionText).toContain('grocery list');
  });

  test('autocomplete filters as user types after [[', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await injectTestNotes(page);

    await page.goto('/#/note/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.cm-content', { timeout: 10000 });

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.waitForTimeout(200);

    // Type [[gro to filter to "grocery list"
    await page.keyboard.type('[[gro', { delay: 50 });
    await page.waitForTimeout(500);

    const tooltip = page.locator('.cm-tooltip-autocomplete');
    await expect(tooltip).toBeVisible({ timeout: 2000 });

    const optionText = await tooltip.innerText();
    expect(optionText).toContain('grocery list');
    // "meeting notes" and "project ideas" should be filtered out
    expect(optionText).not.toContain('meeting notes');
  });

  test('selecting autocomplete option inserts wikilink', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await injectTestNotes(page);

    await page.goto('/#/note/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.cm-content', { timeout: 10000 });

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.waitForTimeout(200);

    // Type [[
    await page.keyboard.type('[[', { delay: 100 });
    await page.waitForTimeout(500);

    const tooltip = page.locator('.cm-tooltip-autocomplete');
    await expect(tooltip).toBeVisible({ timeout: 2000 });

    // Press Enter to select the first option
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    // Editor should now contain [[<note title>]]
    const docText = await editor.evaluate((el) => (el as HTMLElement).textContent);
    expect(docText).toMatch(/\[\[.+\]\]/);
  });

  test('no errors when typing [[ with empty notes cache', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await page.goto('/#/note/new');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.cm-content', { timeout: 10000 });

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.waitForTimeout(200);

    // Type [[ — should not error even with empty cache
    await page.keyboard.type('[[test', { delay: 50 });
    await page.waitForTimeout(300);

    expect(pageErrors).toEqual([]);

    // Text should be in the editor
    const docText = await editor.evaluate((el) => (el as HTMLElement).textContent);
    expect(docText).toContain('[[test');
  });
});
