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

test.describe('P1 ForYouPage Regressions', () => {
  test('focusing ForYouPage elements does not set editorFocused', async ({ page }) => {
    // Bug: on the ForYouPage (no note open), tapping "Browse Notes" on Android
    // triggered onfocusin on .note-body which set editorFocused=true, causing
    // the keyboard toolbar to appear instead of opening the sidebar.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.for-you-page', { timeout: 10000 });

    // Focus the Quick capture button (the only focusable element on desktop ForYouPage)
    const quickCapture = page.locator('.quick-capture-btn');
    await quickCapture.focus();
    await page.waitForTimeout(100);

    // editorFocused should NOT be true — we're on the ForYouPage, not editing a note
    const noteBody = page.locator('.note-body');
    const hasEditorFocused = await noteBody.evaluate(
      (el) => el.hasAttribute('data-editor-focused')
    );
    expect(hasEditorFocused).toBe(false);
  });
});

test.describe('P1 Link Clickability Regressions', () => {
  test('markdown link text is clickable and opens a new page', async ({ page }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill('Open [OpenAI](https://openai.com) now');
    await page.keyboard.press('Control+End');
    await blurEditor(page);

    const markdownLink = page.locator('.cm-md-link', { hasText: 'OpenAI' }).first();
    await expect(markdownLink).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      markdownLink.click()
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('openai.com');
    await popup.close();
  });

  test('plain URL is auto-detected, styled, and clickable', async ({ page }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill('Visit https://example.com for docs');
    await page.keyboard.press('Control+End');
    await blurEditor(page);

    const autoLink = page.locator('.cm-md-autolink', { hasText: 'https://example.com' }).first();
    await expect(autoLink).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      autoLink.click()
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('example.com');
    await popup.close();
  });

  test('table links render as external anchors', async ({ page }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill(`| Name | Link |
|------|------|
| Test | [Example](https://example.com) |

After table`);
    await page.keyboard.press('Control+End');
    await blurEditor(page);

    const tableLink = page.locator('.cm-md-table-link', { hasText: 'Example' }).first();
    await expect(tableLink).toBeVisible();
    await expect(tableLink).toHaveAttribute('href', 'https://example.com');
    await expect(tableLink).toHaveAttribute('target', '_blank');
    await expect(tableLink).toHaveAttribute('rel', /noopener/);
  });
});
