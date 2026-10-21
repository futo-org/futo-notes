/**
 * Folder support v1 — sidebar folder UI.
 *
 * Web mode keeps notes/folders in memory only (`webFS` in
 * `src/lib/platform/web.ts`), so these tests exercise the create /
 * rename / delete / move flows without needing the Tauri backend.
 */

import { test, expect } from '@playwright/test';
import { openSidebar } from './lib/folderSupport';

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
    await expect(page.locator('[data-folder-path="Specs"]').first()).toBeVisible();
  });

  test('an empty folder remains available in the move picker', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Empty');
    await page.getByTestId('create-folder-confirm').click();

    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('move-me', 'body');
    });
    await page.locator('[data-note-id="move-me"]').click();
    await page.getByRole('button', { name: 'Note options' }).click();
    await page.getByTestId('note-menu-move').click();

    await expect(page.locator('.picker-list [data-folder-path="Empty"]')).toBeVisible();
  });

  test('creating a folder with a Windows-reserved name surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('CON');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
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
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
    await expect(page.locator('.modal-error')).toContainText(/already exists/i);
  });

  test('creating a folder with an empty name keeps Create disabled without an error', async ({
    page,
  }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('   ');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
    await expect(page.locator('.modal-error')).toBeHidden();
  });

  test('creating a folder with forbidden characters surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('bad<name>');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
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

  test('folder rename is inline from double-click, F2, and context menu', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Work');
    await page.getByTestId('create-folder-confirm').click();

    const work = page.locator('[data-folder-path="Work"]').first();
    await work.dblclick();
    await page.getByTestId('folder-rename-input').fill('Projects');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Projects"]').first()).toBeVisible();
    await expect(page.getByTestId('create-folder-input')).toBeHidden();

    const projects = page.locator('[data-folder-path="Projects"]').first();
    await projects.focus();
    await page.keyboard.press('F2');
    await page.getByTestId('folder-rename-input').fill('Archive');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Archive"]').first()).toBeVisible();

    const archive = page.locator('[data-folder-path="Archive"]').first();
    await archive.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByTestId('folder-rename-input').fill('Done');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Done"]').first()).toBeVisible();
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
  });

  test('an illegal inline folder rename is reported and keeps the edit', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Work');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('[data-folder-path="Work"]').first()).toBeVisible();

    // A forbidden character used to leave only a red outline and a `title`
    // tooltip — nothing the user could read — so the rename looked like a no-op.
    await page.locator('[data-folder-path="Work"]').first().dblclick();
    const renameInput = page.getByTestId('folder-rename-input');
    await renameInput.fill('a:b');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast')).toHaveText(
      "That character can't be used in a folder name",
    );
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue('a:b');
    await expect(page.locator('[data-folder-path="Work"]').first()).toBeVisible();

    // A slash used to be spliced into the destination path, so "a/b" silently
    // MOVED the folder into a brand-new "a" instead of being rejected.
    await renameInput.fill('a/b');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast')).toHaveText(
      "That character can't be used in a folder name",
    );
    await expect(page.locator('[data-folder-path="a"]')).toHaveCount(0);
    await expect(page.locator('[data-folder-path="a/b"]')).toHaveCount(0);
    await expect(page.locator('[data-folder-path="Work"]').first()).toBeVisible();

    // The preserved edit is still fixable in place.
    await renameInput.fill('Projects');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Projects"]').first()).toBeVisible();
  });

  test('creating a folder shows a toast', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Reports');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('.toast')).toHaveText('Folder created');
    await expect(page.locator('[data-folder-path="Reports"]').first()).toBeVisible();
  });

  test('Escape dismisses the Move to folder picker', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Work');
    await page.getByTestId('create-folder-confirm').click();

    await page.locator('[data-folder-path="Work"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to folder' }).click();
    await expect(page.locator('.modal-backdrop')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  });

  test('a note is renamed inline from double-click and F2', async ({ page }) => {
    await openSidebar(page);
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Groceries', 'milk');
    });
    const row = page.locator('[data-note-id="Groceries"]').first();
    await expect(row).toBeVisible();

    await row.dblclick();
    const renameInput = page.getByTestId('note-rename-input');
    await expect(renameInput).toBeVisible();
    await expect(renameInput).toHaveValue('Groceries');
    await renameInput.fill('grocery list');
    await page.keyboard.press('Enter');
    // The filename IS the title (AGENTS.md M2) — no case or dash prettifying.
    await expect(page.locator('[data-note-id="grocery list"]').first()).toBeVisible();

    // F2 mirrors the folder row, and an illegal name is reported, not swallowed.
    await page.locator('[data-note-id="grocery list"]').first().focus();
    await page.keyboard.press('F2');
    await page.getByTestId('note-rename-input').fill('bad:name');
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast')).toHaveText("That character can't be used in a note title");
    await expect(page.getByTestId('note-rename-input')).toHaveValue('bad:name');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('note-rename-input')).toHaveCount(0);
    await expect(page.locator('[data-note-id="grocery list"]').first()).toBeVisible();
  });

  test('existing folders expose discoverable subfolder creation', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Work');
    await page.getByTestId('create-folder-confirm').click();

    await expect(
      page.locator('[data-folder-path="Work"] [data-testid="folder-add-subfolder"]'),
    ).toHaveCount(0);

    await page.locator('[data-folder-path="Work"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New Folder' }).click();
    await expect(page.locator('.modal-title')).toHaveText('New folder in “Work”');
    await page.getByTestId('create-folder-input').fill('Plans');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('[data-folder-path="Work/Plans"]').first()).toBeVisible();
  });
});
