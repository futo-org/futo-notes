import { expect, type Page, test } from '@playwright/test';

const ISSUE_TRACKER_URL = 'https://github.com/futo-org/futo-notes/issues';

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.sidebar-settings-btn').click();
  await expect(page.locator('.settings-title')).toBeVisible();
}

test('issue reporting exposes the shared copy and GitHub issue tracker link', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: (url: string | URL | undefined) => {
        (
          window as typeof window & {
            __openedExternalUrl?: string;
          }
        ).__openedExternalUrl = String(url);
        return null;
      },
    });
  });

  await openSettings(page);

  await expect(page.getByRole('heading', { name: 'Issue Reporting' })).toBeVisible();
  await expect(page.getByText('Send crashes automatically', { exact: true })).toBeVisible();
  await expect(page.getByText('Crash Reporting', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Always send automatically', { exact: true })).toHaveCount(0);

  const shareCrashReportsRow = page.locator('.settings-issue-first-row');
  const sendCrashesAutomaticallyRow = page.locator('.settings-issue-middle-row');
  const reportIssueRow = page.locator('.settings-issue-link');

  await expect(shareCrashReportsRow).toHaveCSS('border-radius', '12px 12px 0px 0px');
  await expect(sendCrashesAutomaticallyRow).toHaveCSS('border-radius', '0px');
  await expect(reportIssueRow).toHaveCSS('border-radius', '0px 0px 12px 12px');

  await page.getByRole('button', { name: /Report an issue/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __openedExternalUrl?: string;
            }
          ).__openedExternalUrl,
      ),
    )
    .toBe(ISSUE_TRACKER_URL);
});

// Regression: github.com/futo-org/futo-notes/issues/31 — "Send crashes
// automatically" sat 8px further right than the rows above and below it
// (a leftover `.settings-toggle-row.sub { padding-left: 24px }` from when it
// was the last row of a two-row card). The dependency on "Share crash
// reports" is expressed by conditional presence, exactly as the native
// shells do it — never by a horizontal offset.
test('issue reporting rows share one left edge', async ({ page }) => {
  await openSettings(page);

  const rows = [
    page.locator('.settings-issue-first-row'),
    page.locator('.settings-issue-middle-row'),
    page.locator('.settings-issue-link'),
  ];

  // Every row in the group uses the shared row inset — no row is indented.
  for (const row of rows) {
    await expect(row).toHaveCSS('padding-left', '16px');
  }

  // And the labels actually line up on screen.
  const labelLefts = await Promise.all(
    rows.map(async (row) => {
      const box = await row.locator('.settings-btn-label').boundingBox();
      if (!box) throw new Error('settings row label is not rendered');
      return box.x;
    }),
  );
  expect(new Set(labelLefts).size).toBe(1);
});
