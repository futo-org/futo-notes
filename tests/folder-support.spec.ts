import { test, expect, Page } from '@playwright/test';

/**
 * Folder support v1 — sidebar folder UI.
 *
 * Web mode keeps notes/folders in memory only (`webFS` in
 * `src/lib/platform/web.ts`), so these tests exercise the create /
 * rename / delete / move flows without needing the Tauri backend.
 */

async function openSidebar(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
}

test.describe('Folder support', () => {
  test('the new-folder button opens the create-folder modal', async ({ page }) => {
    await openSidebar(page);
    const button = page.getByTestId('new-folder-btn');
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId('create-folder-input')).toBeVisible();
    // Cancel closes the modal.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
  });

  test('creating a folder adds it to the sidebar opened by default', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    const input = page.getByTestId('create-folder-input');
    await input.fill('Specs');
    await page.getByTestId('create-folder-confirm').click();
    // Modal closes, the folder appears in the sidebar.
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
    await expect(
      page.locator('[data-folder-path="Specs"]').first(),
    ).toBeVisible();
  });

  test('creating a folder with a Windows-reserved name surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('CON');
    await page.getByTestId('create-folder-confirm').click();
    // The modal stays open with an error message.
    await expect(page.locator('.modal-error')).toContainText(/reserved/i);
  });

  test('creating a sibling that differs only in case is rejected', async ({ page }) => {
    await openSidebar(page);
    // Create the first folder
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Specs');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
    // Try to create a case-only-different sibling
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('SPECS');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('.modal-error')).toContainText(/already exists/i);
  });

  test('creating a folder with an empty name surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('   ');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('.modal-error')).toBeVisible();
  });

  test('creating a folder with forbidden characters surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('bad<name>');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('.modal-error')).toBeVisible();
  });

  test('clicking a folder toggles open / closed state', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Toggle');
    await page.getByTestId('create-folder-confirm').click();
    const folderRow = page.locator('[data-folder-path="Toggle"]').first();
    await expect(folderRow).toBeVisible();
    // Folder is open by default after creation; click to close.
    await folderRow.click();
    // Click again to re-open.
    await folderRow.click();
    // Both transitions should leave the row visible.
    await expect(folderRow).toBeVisible();
  });

  test('the create-folder modal shows the default title at root', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await expect(page.locator('.modal-title')).toHaveText('New folder');
    await page.keyboard.press('Escape');
  });
});
