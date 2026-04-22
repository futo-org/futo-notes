import { test, expect } from '@playwright/test';

test.describe('Brand emoji cycling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.removeItem('futo-notes:emoji');
      localStorage.removeItem('stonefruit-emoji');
    });
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

  test('migrates the legacy stonefruit-emoji localStorage key', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem('futo-notes:emoji');
      localStorage.setItem('stonefruit-emoji', '🍒');
    });
    await page.reload();
    await expect(page.locator('.brand-emoji')).toHaveText('🍒');
    const [legacy, current] = await page.evaluate(() => [
      localStorage.getItem('stonefruit-emoji'),
      localStorage.getItem('futo-notes:emoji'),
    ]);
    expect(legacy).toBeNull();
    expect(current).toBe('🍒');
  });

  test('brand text navigates home', async ({ page }) => {
    await page.locator('.brand-text').click();
    await expect(page).toHaveURL(/\/$/);
  });
});
