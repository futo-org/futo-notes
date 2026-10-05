import { test, expect, type Page } from '@playwright/test';

async function openSidebar(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
}

async function seedNotes(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const win = window as unknown as {
      __testNotes: { writeNote: (id: string, body: string, mtime: number) => Promise<unknown> };
    };
    await win.__testNotes.writeNote('banana', 'b', 1_000);
    await win.__testNotes.writeNote('Cherry', 'c', 2_000);
    await win.__testNotes.writeNote('apple', 'a', 3_000);
  });
}

async function noteOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-note-id]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-note-id')));
}

async function pick(page: Page, label: string): Promise<void> {
  if ((await page.getByRole('menu').count()) === 0) {
    await page.getByTestId('note-sort-btn').click();
  }
  await page.getByRole('menuitemradio', { name: label }).click();
}

test.describe('Note list sort', () => {
  test('a pick re-renders the list in the store order and the menu stays open', async ({
    page,
  }) => {
    await openSidebar(page);
    await seedNotes(page);

    await pick(page, 'Name');
    await expect.poll(() => noteOrder(page)).toEqual(['apple', 'banana', 'Cherry']);
    await expect(page.getByRole('menu')).toBeVisible();

    await pick(page, 'Z-A');
    await expect.poll(() => noteOrder(page)).toEqual(['Cherry', 'banana', 'apple']);

    await page.getByText('For You', { exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('the menu marks the active choice and survives a reload', async ({ page }) => {
    await openSidebar(page);
    await pick(page, 'Name');
    await expect(page.getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('menuitemradio', { name: 'A-Z' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.keyboard.press('Escape');

    await page.reload();
    await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
    await page.getByTestId('note-sort-btn').click();
    await expect(page.getByRole('menuitemradio', { name: 'Name' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('the For You feed stays recency-ordered under a Name sort', async ({ page }) => {
    await openSidebar(page);
    await seedNotes(page);

    await pick(page, 'Name');
    await expect.poll(() => noteOrder(page)).toEqual(['apple', 'banana', 'Cherry']);
    await page.keyboard.press('Escape');

    await expect
      .poll(() =>
        page
          .locator('.for-you-card-title')
          .evaluateAll((titles) => titles.map((title) => title.textContent)),
      )
      .toEqual(['apple', 'Cherry', 'banana']);
  });

  test('the sort control only shows on the notes view', async ({ page }) => {
    await openSidebar(page);
    await expect(page.getByTestId('note-sort-btn')).toBeVisible();
    await page.getByRole('button', { name: 'Tags view' }).click();
    await expect(page.getByTestId('note-sort-btn')).toHaveCount(0);
  });
});
