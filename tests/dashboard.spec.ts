import { test, expect } from '@playwright/test';

const SERVER_URL = 'http://localhost:3005';

test.describe('Server Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Check server is running
    try {
      const res = await page.request.get(`${SERVER_URL}/health`);
      expect(res.ok()).toBeTruthy();
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
});
