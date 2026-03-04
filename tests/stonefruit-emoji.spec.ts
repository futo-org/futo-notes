import { test, expect } from '@playwright/test';

test.describe('Stonefruit emoji cycling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Clear persisted emoji state
    await page.evaluate(() => localStorage.removeItem('stonefruit-emoji'));
    await page.reload();
  });

  test('emoji cycles through stone fruits on click', async ({ page }) => {
    const emoji = page.locator('.brand-emoji');
    await expect(emoji).toHaveText('🥑');
    await emoji.click();
    await expect(emoji).toHaveText('🍑');
    await emoji.click();
    await expect(emoji).toHaveText('🍒');
    await emoji.click();
    await expect(emoji).toHaveText('🥥');
    await emoji.click();
    await expect(emoji).toHaveText('🥭');
    await emoji.click();
    await expect(emoji).toHaveText('🫒');
    // Wraps back to start
    await emoji.click();
    await expect(emoji).toHaveText('🥑');
  });

  test('selected emoji persists across page reload', async ({ page }) => {
    const emoji = page.locator('.brand-emoji');
    await emoji.click(); // 🥑 → 🍑
    await expect(emoji).toHaveText('🍑');
    await page.reload();
    await expect(page.locator('.brand-emoji')).toHaveText('🍑');
  });

  test('brand text navigates home', async ({ page }) => {
    await page.locator('.brand-text').click();
    await expect(page).toHaveURL(/\/$/);
  });
});
