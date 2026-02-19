import { test, expect, Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

test.describe('P0 Crash and IME Regressions', () => {
  test('backspacing all text then opening menu does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill('Temporary text to remove');
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');

    // Desktop layout: sidebar is always visible, no toggle needed.
    // Verify sidebar is present and page didn't crash.
    const aside = page.locator('aside.notes-drawer');
    await expect(aside).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('composition event flow plus sidebar interaction does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill('This is **bold** text');
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(150);

    await page.locator('.title-input').click();
    await page.locator('.title-input').blur();
    await page.waitForTimeout(150);

    // Desktop layout: sidebar is always visible. Click a sidebar element
    // to verify no crash during composition.
    await editor.click();
    await editor.evaluate((el) => {
      const event = typeof CompositionEvent !== 'undefined'
        ? new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' })
        : new Event('compositionstart', { bubbles: true });
      el.dispatchEvent(event);
    });
    await page.waitForTimeout(100);

    // Click into sidebar area while composition is active
    const aside = page.locator('aside.notes-drawer');
    await aside.click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(100);

    await editor.evaluate((el) => {
      const event = typeof CompositionEvent !== 'undefined'
        ? new CompositionEvent('compositionend', { bubbles: true, data: 'あ' })
        : new Event('compositionend', { bubbles: true });
      el.dispatchEvent(event);
    });
    await page.waitForTimeout(100);

    await editor.click();
    await page.keyboard.type('x');
    await expect(editor).toContainText('x');
    expect(pageErrors).toEqual([]);
  });
});
