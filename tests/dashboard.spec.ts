import { test, expect } from '@playwright/test';

const SERVER_URL = process.env.SERVER_DASHBOARD_URL || 'http://localhost:3005';
const DASHBOARD_PASSWORD = process.env.SERVER_DASHBOARD_PASSWORD || 'dashboard-pass';

test.describe('Server Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Check server is running
    try {
      const health = await page.request.get(`${SERVER_URL}/health`);
      expect(health.ok()).toBeTruthy();
      const data = await health.json();
      if (!data.setup_complete) {
        const setup = await page.request.post(`${SERVER_URL}/setup`, {
          data: { password: DASHBOARD_PASSWORD },
        });
        expect(setup.ok()).toBeTruthy();
      }
    } catch {
      test.skip(true, 'Server not running on port 3005');
    }
  });

  test('dashboard loads without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(SERVER_URL);

    // Wait for the status to load (the "..." placeholders should be replaced)
    await expect(page.locator('#status')).not.toHaveText('...', { timeout: 10000 });

    // Server status should show "Online"
    await expect(page.locator('#status')).toContainText('Online');

    // Notes count should be a number
    const notesText = await page.locator('#notes-count').textContent();
    expect(notesText).toBeTruthy();
    expect(notesText).not.toBe('...');

    // Search section should have loaded (not stuck on "Loading...")
    const searchContent = await page.locator('#search-content').textContent();
    expect(searchContent).not.toBe('Loading...');
    expect(searchContent!.length).toBeGreaterThan(0);

    // No JS errors
    expect(errors).toEqual([]);
  });

  test('dashboard status API returns valid JSON', async ({ page }) => {
    const res = await page.request.get(`${SERVER_URL}/dashboard/status`);
    expect(res.ok()).toBeTruthy();

    const data = await res.json();
    expect(data).toHaveProperty('notes_count');
    expect(data).toHaveProperty('search');
    expect(data).toHaveProperty('uptime_seconds');
    expect(typeof data.notes_count).toBe('number');
    expect(typeof data.uptime_seconds).toBe('number');
  });

  test('plugins render as cards and switches require login', async ({ page }) => {
    await page.goto(SERVER_URL);

    await expect(page.locator('#plugin-grid')).toBeVisible({ timeout: 10000 });
    const gridColumns = await page.locator('#plugin-grid').evaluate((node) => getComputedStyle(node).gridTemplateColumns);
    expect(gridColumns.split(' ').filter(Boolean)).toHaveLength(2);

    const pluginCards = page.locator('[data-plugin-card]');
    await expect(pluginCards.first()).toBeVisible();
    await expect(pluginCards).toHaveCount(1);

    const pluginSwitch = page.locator('[data-plugin-switch]').first();
    await expect(pluginSwitch).toBeDisabled();

    page.once('dialog', (dialog) => dialog.accept(DASHBOARD_PASSWORD));
    await page.getByRole('button', { name: 'Log in' }).click();

    await expect(page.locator('.plugin-auth-note')).toContainText('Signed in for plugin controls');
    await expect(page.locator('[data-plugin-switch]').first()).toBeEnabled();
  });
});
