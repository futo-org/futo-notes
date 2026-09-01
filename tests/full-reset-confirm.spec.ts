import { test, expect, Page } from '@playwright/test';

// Regression: the danger-zone "Full reset" used to be an in-place two-tap
// ("Full reset" → "Tap again to confirm" → wipes). A stray double-tap wiped
// everything too easily, so it now goes through a modal confirmation dialog
// (confirmDialog → the app-owned ConfirmDialogHost). See
// docs/spec/settings.md "Danger zone — Full reset".

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.sidebar-settings-btn').click();
  await expect(page.locator('.settings-title')).toBeVisible();
}

const fullResetButton = (page: Page) => page.getByRole('button', { name: /Full reset/ });

test.describe('Danger zone — Full reset confirmation', () => {
  test('opens a confirm dialog and dismissing it keeps all notes', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(async () => {
      await (
        window as unknown as {
          __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
        }
      ).__testNotes.createNote('keep-me', 'precious');
    });

    await page.locator('.sidebar-settings-btn').click();
    await expect(page.locator('.settings-title')).toBeVisible();

    await fullResetButton(page).click();

    // The destructive action is gated by a confirmation dialog...
    const dialog = page.getByRole('dialog', { name: 'Full reset' });
    await expect(dialog).toContainText('Permanently delete all notes');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // ...the old in-place two-tap state is gone...
    await expect(page.getByText('Tap again to confirm')).toHaveCount(0);
    // ...nothing was deleted (no blocking overlay, settings still open)...
    await expect(page.getByText('Deleting all notes')).toHaveCount(0);
    await expect(page.locator('.settings-title')).toBeVisible();
    // ...and the seeded note survived the dismissed dialog.
    const stillThere = await page.evaluate(() =>
      (
        window as unknown as { __testNotes: { noteExists: (id: string) => Promise<boolean> } }
      ).__testNotes.noteExists('keep-me'),
    );
    expect(stillThere).toBe(true);
  });

  test('confirming the dialog wipes the vault and reloads', async ({ page }) => {
    await openSettings(page);

    // doNuke() → resetAllNotes() → window.location.reload(): accepting the
    // confirm must take the wipe path, which reloads the page.
    const reloaded = page.waitForEvent('load');
    await fullResetButton(page).click();
    await page
      .getByRole('dialog', { name: 'Full reset' })
      .getByRole('button', { name: 'Confirm' })
      .click();
    await reloaded;

    // After the reload we are back on a fresh boot (settings closed).
    await expect(page.locator('.settings-title')).toHaveCount(0);
  });
});
