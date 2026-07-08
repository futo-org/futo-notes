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

async function setCursorPosition(page: Page, ch: number): Promise<void> {
  await page.evaluate((nextCh) => {
    const view = (window as any).__cmGetView?.();
    if (!view) throw new Error('CM EditorView not found');
    const line = view.state.doc.line(1);
    view.dispatch({ selection: { anchor: line.from + nextCh } });
    view.focus();
  }, ch);
  await page.waitForTimeout(100);
}

test.describe('P1 ForYouPage Regressions', () => {
  test('ForYouPage does not set editorFocused', async ({ page }) => {
    // Bug: on the ForYouPage (no note open), tapping "Browse Notes" on Android
    // triggered onfocusin on .note-body which set editorFocused=true, causing
    // the keyboard toolbar to appear instead of opening the sidebar.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.for-you-page', { timeout: 10000 });
    await page.locator('.for-you-page').click();
    await page.waitForTimeout(100);

    const noteBody = page.locator('.note-body');
    const hasEditorFocused = await noteBody.evaluate((el) =>
      el.hasAttribute('data-editor-focused'),
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

    const [popup] = await Promise.all([page.waitForEvent('popup'), markdownLink.click()]);
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

    const [popup] = await Promise.all([page.waitForEvent('popup'), autoLink.click()]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('example.com');
    await popup.close();
  });

  // The exact cursor placement here is racy in CI: focusing the editor on
  // mousedown reveals source view synchronously and shifts CM's posAtCoords
  // result. The actual regression target is "no popup opened" — a click past
  // a link must not navigate. Cursor position is implementation detail.
  test('clicking to the right of an end-of-line markdown link does not open the link', async ({
    page,
  }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill('See [OpenAI](https://openai.com)');
    await setCursorPosition(page, 0);
    await blurEditor(page);

    const markdownLink = page.locator('.cm-md-link', { hasText: 'OpenAI' }).first();
    await expect(markdownLink).toBeVisible();

    const linkBox = await markdownLink.boundingBox();
    expect(linkBox).not.toBeNull();
    const lineBox = await page.locator('.cm-line').first().boundingBox();
    expect(lineBox).not.toBeNull();

    let popupOpened = false;
    page.on('popup', () => {
      popupOpened = true;
    });

    await page.mouse.click(linkBox!.x + linkBox!.width + 4, lineBox!.y + lineBox!.height / 2);
    await page.waitForTimeout(250);

    expect(popupOpened).toBe(false);
  });

  test('clicking to the right of an end-of-line plain URL does not open the link', async ({
    page,
  }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill('Visit https://example.com');
    await setCursorPosition(page, 0);
    await blurEditor(page);

    const autoLink = page.locator('.cm-md-autolink', { hasText: 'https://example.com' }).first();
    await expect(autoLink).toBeVisible();

    const linkBox = await autoLink.boundingBox();
    expect(linkBox).not.toBeNull();
    const lineBox = await page.locator('.cm-line').first().boundingBox();
    expect(lineBox).not.toBeNull();

    let popupOpened = false;
    page.on('popup', () => {
      popupOpened = true;
    });

    await page.mouse.click(linkBox!.x + linkBox!.width + 4, lineBox!.y + lineBox!.height / 2);
    await page.waitForTimeout(250);

    expect(popupOpened).toBe(false);
  });

  test('table cells surface markdown link source (editable, not rendered)', async ({ page }) => {
    // Prior behavior: the read-only TableWidget rendered `[text](url)` as an <a>.
    // Current behavior (interactive editor): cells are contentEditable plain text, so
    // the raw markdown is visible. Inline rendering in cells would fight the cell caret.
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await editor.fill(`| Name | Link |
|------|------|
| Test | [Example](https://example.com) |

After table`);
    await page.keyboard.press('Control+End');
    await blurEditor(page);

    const cell = page.locator('.sf-table td .sf-table__cell', { hasText: 'Example' }).first();
    await expect(cell).toBeVisible();
    await expect(cell).toHaveAttribute('contenteditable', 'true');
    // Raw markdown is present in the cell text
    await expect(cell).toContainText('[Example](https://example.com)');
  });
});

test.describe('P1 Note Selection Regressions', () => {
  test('selecting a note does not trigger a save (no mtime bump)', async ({ page }) => {
    // Bug: setContent fires CM6 docChanged which schedules onchange via rAF.
    // By the time the rAF fires, loading=false, so debouncedSave runs and
    // writes the note with identical content, bumping its mtime and moving
    // it to the top of the recency-sorted sidebar list.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!(window as any).__testNotes, null, { timeout: 15000 });

    // Create two notes
    await page.evaluate(async () => {
      await (window as any).__testNotes.createNote('note-alpha', 'Alpha note content here');
      await (window as any).__testNotes.createNote('note-beta', 'Beta note content here');
    });

    // Record initial mtime for note-beta
    const mtimeBefore = await page.evaluate(() => {
      const notes = (window as any).__testNotes.getAllNotes();
      return notes.find((n: any) => n.id === 'note-beta')?.modificationTime;
    });
    expect(mtimeBefore).toBeTruthy();

    // Open note-alpha first to initialize the editor
    await page.goto('/#/note/note-alpha');
    await page.waitForSelector('.cm-content', { timeout: 10000 });
    await page.waitForTimeout(700); // Wait past the 500ms save debounce

    // Now select note-beta (this is the action under test)
    await page.goto('/#/note/note-beta');
    await page.waitForSelector('.cm-content', { timeout: 10000 });
    await page.waitForFunction(
      () => {
        const v = (window as any).__cmGetView?.();
        return v && v.state.doc.toString().includes('Beta note');
      },
      null,
      { timeout: 10000 },
    );

    // Wait past the rAF + debounce window (500ms debounce + 200ms buffer)
    await page.waitForTimeout(800);

    // Check that note-beta's mtime did NOT change — selecting shouldn't modify it
    const mtimeAfter = await page.evaluate(() => {
      const notes = (window as any).__testNotes.getAllNotes();
      return notes.find((n: any) => n.id === 'note-beta')?.modificationTime;
    });
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
