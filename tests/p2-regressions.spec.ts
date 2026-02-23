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

  // Toggle formatting via CM6 view (toolbar is mobile-only, not available in Playwright)
  async function toggleFormatting(page: Page, fn: string): Promise<void> {
    await page.evaluate((fnName) => {
      const w = window as any;
      const view = w.__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      w.__cmToggle(view, fnName);
    }, fn);
  }

  test('checkbox toggle does not focus editor when it was unfocused', async ({ page }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.type('- [ ] Buy milk');

    // Blur the editor so nothing is focused inside it
    await blurEditor(page);

    // Verify editor is not focused
    const focusedBefore = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.cm-editor'))
    );
    expect(focusedBefore).toBe(false);

    // Wait for the checkbox widget to render (editor unfocused → decorations apply)
    const checkbox = page.locator('.cm-md-task-checkbox').first();
    await expect(checkbox).toBeVisible({ timeout: 5000 });

    // Click the checkbox
    await checkbox.click();

    // Wait a tick for any focus side-effects
    await page.waitForTimeout(100);

    // Editor should still NOT be focused
    const focusedAfter = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.cm-editor'))
    );
    expect(focusedAfter).toBe(false);

    // But the checkbox should have toggled ([ ] → [x])
    const raw = await page.evaluate(() => {
      const w = window as any;
      return w.__cmGetView?.()?.state.doc.toString() ?? '';
    });
    expect(raw).toContain('[x]');
  });

  const formattingCases = [
    { fn: 'bold', cssClass: '.cm-md-strong', sample: 'boldword', marker: '**' },
    { fn: 'italic', cssClass: '.cm-md-emphasis', sample: 'italicword', marker: '*' },
    { fn: 'strikethrough', cssClass: '.cm-md-strikethrough', sample: 'strikeword', marker: '~~' }
  ];

  for (const tc of formattingCases) {
    test(`${tc.fn} keeps trailing space outside closing marker`, async ({ page }) => {
      await openNewNote(page);

      const editor = page.locator('.cm-content');
      await editor.click();

      await toggleFormatting(page, tc.fn);
      await page.keyboard.type(`${tc.sample} `);
      await toggleFormatting(page, tc.fn);
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
