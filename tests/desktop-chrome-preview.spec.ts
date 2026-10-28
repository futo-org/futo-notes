import { expect, test } from '@playwright/test';

test('previews the actual desktop tab strip and sidebar toggle without a native runtime', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/desktop-chrome/index.html');
  await expect(page.locator('.desktop-topband')).toBeVisible();
  await expect(page.getByRole('tab', { name: /Chrome preview/ })).toBeVisible();
  const toggle = page.locator('.sidebar-toggle-btn');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: /New tab/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath('desktop-chrome.png') });
  expect(errors).toEqual([]);
});
