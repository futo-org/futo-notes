// Sidebar helpers shared by the folder-support*.spec.ts suites, moved here
// verbatim from folder-support.spec.ts.

import type { Page } from '@playwright/test';

export async function openSidebar(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
}

// Deletes confirm through the app-owned ConfirmDialogHost modal, not a native dialog.
export async function confirmModal(page: Page, title: string): Promise<void> {
  await page.getByRole('dialog', { name: title }).getByRole('button', { name: 'Confirm' }).click();
}
