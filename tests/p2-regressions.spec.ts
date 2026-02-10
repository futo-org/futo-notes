import { test, expect, Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

async function blurEditor(page: Page): Promise<void> {
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(200);
}

test.describe('P2 Header + Formatting Regressions', () => {
  test('pressing Enter in title moves focus to note body editor', async ({ page }) => {
    await openNewNote(page);

    const titleInput = page.locator('.title-input');
    await titleInput.click();
    await titleInput.fill('My Title');
    await titleInput.press('Enter');

    const editorFocused = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.cm-editor'))
    );
    expect(editorFocused).toBe(true);

    await page.keyboard.type('Body content');
    await expect(page.locator('.cm-content')).toContainText('Body content');
  });

  test('tapping Untitled title allows quick full delete', async ({ page }) => {
    await openNewNote(page);

    const titleInput = page.locator('.title-input');
    const initialValue = await titleInput.inputValue();
    expect(initialValue.startsWith('Untitled')).toBe(true);

    await titleInput.click();
    await titleInput.press('Backspace');
    await expect(titleInput).toHaveValue('');
  });

  test('tapping non-Untitled title does not force select-all', async ({ page }) => {
    await openNewNote(page);

    const titleInput = page.locator('.title-input');
    await titleInput.click();
    await titleInput.fill('Project Notes');
    await titleInput.press('ArrowLeft');
    await titleInput.press('ArrowLeft');
    await titleInput.click();

    const selection = await titleInput.evaluate((el) => {
      const input = el as HTMLInputElement;
      return {
        start: input.selectionStart,
        end: input.selectionEnd
      };
    });

    expect(selection.start).toBe(selection.end);
  });

  const formattingCases = [
    { label: 'Bold', cssClass: '.cm-md-strong', sample: 'boldword', marker: '**' },
    { label: 'Italic', cssClass: '.cm-md-emphasis', sample: 'italicword', marker: '*' },
    { label: 'Strikethrough', cssClass: '.cm-md-strikethrough', sample: 'strikeword', marker: '~~' }
  ];

  for (const tc of formattingCases) {
    test(`${tc.label} keeps trailing space outside closing marker`, async ({ page }) => {
      await openNewNote(page);

      const editor = page.locator('.cm-content');
      await editor.click();

      await page.getByLabel(tc.label).click();
      await page.keyboard.type(`${tc.sample} `);
      await page.getByLabel(tc.label).click();
      await page.keyboard.type('tail');

      await blurEditor(page);

      const formatted = page.locator(tc.cssClass).first();
      await expect(formatted).toBeVisible();
      await expect(formatted).toHaveText(tc.sample);

      const visibleText = await editor.textContent();
      expect(visibleText).not.toContain(`${tc.marker}tail`);
    });
  }
});
