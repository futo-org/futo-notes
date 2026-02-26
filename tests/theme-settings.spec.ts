import { test, expect, Page } from '@playwright/test';

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.sidebar-settings-btn').click();
  await expect(page.locator('.settings-title')).toBeVisible();
}

async function getTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? null);
}

function themeButton(page: Page, name: 'Auto' | 'Dark' | 'Light') {
  return page.locator('.settings-segmented').getByRole('button', { name, exact: true });
}

test.describe('Theme Settings', () => {
  test('segmented control applies dark and light immediately', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);

    await themeButton(page, 'Dark').click();
    await expect.poll(() => getTheme(page)).toBe('dark');

    await themeButton(page, 'Light').click();
    await expect.poll(() => getTheme(page)).toBe('light');
  });

  test('auto follows system theme changes', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSettings(page);

    await themeButton(page, 'Auto').click();
    await expect.poll(() => getTheme(page)).toBe('light');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => getTheme(page)).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => getTheme(page)).toBe('light');
  });
});
