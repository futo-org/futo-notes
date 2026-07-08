import { test, expect } from '@playwright/test';

test.describe('Sidebar Collapse/Expand', () => {
  test('collapse button hides sidebar, expand button restores it', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const sidebar = page.locator('.notes-drawer');
    const collapseBtn = page.locator('.sidebar-collapse-btn');
    const expandBtn = page.locator('.sidebar-expand-btn');

    // Sidebar should be visible initially
    await expect(sidebar).toBeVisible();
    await expect(collapseBtn).toBeVisible();
    await expect(expandBtn).not.toBeVisible();

    // Collapse
    await collapseBtn.click();
    await expect(page.locator('.notes-shell')).toHaveClass(/sidebar-collapsed/);
    await expect(expandBtn).toBeVisible();

    const firstTab = page.locator('.tab-pill').first();
    if (await firstTab.count()) {
      const expandBox = await expandBtn.boundingBox();
      const firstTabBox = await firstTab.boundingBox();
      expect(expandBox).not.toBeNull();
      expect(firstTabBox).not.toBeNull();
      const boxesIntersect =
        expandBox!.x < firstTabBox!.x + firstTabBox!.width &&
        expandBox!.x + expandBox!.width > firstTabBox!.x &&
        expandBox!.y < firstTabBox!.y + firstTabBox!.height &&
        expandBox!.y + expandBox!.height > firstTabBox!.y;
      expect(boxesIntersect).toBe(false);
    }

    // localStorage should reflect collapsed state
    const stored = await page.evaluate(() => localStorage.getItem('futo-notes:sidebarCollapsed'));
    expect(stored).toBe('true');

    // Expand
    await expandBtn.click();
    await expect(page.locator('.notes-shell')).not.toHaveClass(/sidebar-collapsed/);
    await expect(expandBtn).not.toBeVisible();
    await expect(collapseBtn).toBeVisible();

    const storedAfter = await page.evaluate(() =>
      localStorage.getItem('futo-notes:sidebarCollapsed'),
    );
    expect(storedAfter).toBe('false');
  });
});
