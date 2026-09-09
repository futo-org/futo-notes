import { expect, type Page, test } from '@playwright/test';

async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.sidebar-settings-btn').click();
  await expect(page.locator('.settings-title')).toBeVisible();
}

test('issue reporting exposes the shared copy and the feedback form', async ({ page }) => {
  await openSettings(page);

  await expect(page.getByRole('heading', { name: 'Issue Reporting' })).toBeVisible();
  await expect(page.getByText('Send crashes automatically', { exact: true })).toBeVisible();
  await expect(page.getByText('Crash Reporting', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Always send automatically', { exact: true })).toHaveCount(0);

  const shareCrashReportsRow = page.locator('.settings-issue-first-row');
  const sendCrashesAutomaticallyRow = page.locator('.settings-issue-middle-row');
  const sendFeedbackRow = page.locator('.settings-issue-link');

  await expect(shareCrashReportsRow).toHaveCSS('border-radius', '12px 12px 0px 0px');
  await expect(sendCrashesAutomaticallyRow).toHaveCSS('border-radius', '0px');
  await expect(page.locator('.settings-issue-feedback')).toHaveCSS(
    'border-radius',
    '0px 0px 12px 12px',
  );
  await expect(sendFeedbackRow).toHaveCSS('border-radius', '0px');

  await expect(page.getByRole('button', { name: /Report an issue/ })).toHaveCount(0);

  await page.getByRole('button', { name: /Send feedback/ }).click();

  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();

  await page.locator('.feedback-message').fill('The toolbar hides my cursor.');
  await expect(send).toBeEnabled();

  await page.getByRole('button', { name: /Send feedback/ }).click();
  await expect(page.locator('.feedback-form')).toHaveCount(0);
});

test('the send feedback row discloses the form inside the card', async ({ page }) => {
  await openSettings(page);
  const row = page.getByRole('button', { name: /Send feedback/ });

  await expect(row).toHaveAttribute('aria-expanded', 'false');

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.settings-issue-feedback .settings-issue-form')).toBeVisible();
  await expect(page.locator('.settings-issue-chevron')).toHaveCSS(
    'transform',
    'matrix(0, 1, -1, 0, 0, 0)',
  );

  await row.click();
  await expect(page.locator('.feedback-form')).toHaveCount(0);
});

test('a feedback draft survives closing settings', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('button', { name: /Send feedback/ }).click();
  await page.locator('.feedback-message').fill('Typed, then walked away.');

  await page.locator('.settings-close').click();
  await page.locator('.sidebar-settings-btn').click();
  await page.getByRole('button', { name: /Send feedback/ }).click();

  await expect(page.locator('.feedback-message')).toHaveValue('Typed, then walked away.');
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

test('a dev build shows which server the feedback goes to, and can switch it', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('button', { name: /Send feedback/ }).click();

  const devToggle = page.locator('.feedback-dev-endpoint');
  await expect(devToggle).toContainText('http://localhost:5100');

  await devToggle.locator('input[type="checkbox"]').check();

  await expect(devToggle).toContainText('https://staging-notes-crashlog.futo.org');
  expect(await page.evaluate(() => window.localStorage.getItem('futo_crashlog_staging'))).toBe(
    'true',
  );
});
