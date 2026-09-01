import { test, expect, Page } from '@playwright/test';

import { EDITOR, openNewNote, setEditorMarkdown, waitForEditor } from './lib/desktopEditor';

/**
 * P1 regressions: link clickability, editor-focus reporting, and the save
 * that a mere note SELECTION must not trigger.
 *
 * Deleted with the CodeMirror engine, along with the spec lines they locked:
 *
 * - The three AUTOLINK cases (`plain URL is auto-detected, styled, and
 *   clickable`, and the two click-past-a-plain-URL cases). `links/autolinks.ts`
 *   is gone; a bare URL is only linkified when the note is PARSED, so one just
 *   typed is not a link until the note is reopened. Recorded as a Gap in
 *   docs/spec/editor.md.
 * - `table cells surface markdown link source (editable, not rendered)`. That
 *   was the CodeMirror interactive table widget, whose cells were plain-text
 *   editing surfaces showing raw `[text](url)`. A WYSIWYG table cell holds a
 *   rendered link, so the assertion inverts rather than ports; table editing is
 *   covered by `tests/editor-embed-milkdown-interactive.spec.ts`.
 * - `clicking past the end of a wrapped plain URL places the caret` — an
 *   autolink case, and its assertion read a CodeMirror caret offset.
 */

async function blurEditor(page: Page): Promise<void> {
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(200);
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
  test('a markdown link is clickable and opens a new page', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'Open [OpenAI](https://openai.com) now');
    await blurEditor(page);

    // A real anchor in the document, not a decoration over source text.
    const link = page.locator(`${EDITOR} a`, { hasText: 'OpenAI' }).first();
    await expect(link).toBeVisible();

    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('openai.com');
    await popup.close();
  });

  // The regression target is "no popup opened" — a click PAST a link must not
  // navigate. Where the caret ends up is the platform's own hit-testing now.
  test('clicking to the right of an end-of-line link does not open it', async ({ page }) => {
    await openNewNote(page);
    await setEditorMarkdown(page, 'See [OpenAI](https://openai.com)');
    await blurEditor(page);

    const link = page.locator(`${EDITOR} a`, { hasText: 'OpenAI' }).first();
    await expect(link).toBeVisible();

    const linkBox = await link.boundingBox();
    expect(linkBox).not.toBeNull();

    let popupOpened = false;
    page.on('popup', () => {
      popupOpened = true;
    });

    await page.mouse.click(linkBox!.x + linkBox!.width + 20, linkBox!.y + linkBox!.height / 2);
    await page.waitForTimeout(250);

    expect(popupOpened).toBe(false);
  });
});

test.describe('P1 Note Selection Regressions', () => {
  test('selecting a note does not trigger a save (no mtime bump)', async ({ page }) => {
    // Bug: setContent fires a document change which schedules onchange. By the
    // time it fires, loading=false, so debouncedSave runs and writes the note
    // with identical content, bumping its mtime and moving it to the top of the
    // recency-sorted sidebar list.
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => !!(window as any).__testNotes, null, { timeout: 15000 });

    await page.evaluate(async () => {
      await (window as any).__testNotes.createNote('note-alpha', 'Alpha note content here');
      await (window as any).__testNotes.createNote('note-beta', 'Beta note content here');
    });

    const mtimeBefore = await page.evaluate(() => {
      const notes = (window as any).__testNotes.getAllNotes();
      return notes.find((n: any) => n.id === 'note-beta')?.modificationTime;
    });
    expect(mtimeBefore).toBeTruthy();

    // Open note-alpha first to initialize the editor.
    await page.goto('/#/note/note-alpha');
    await waitForEditor(page);
    await page.waitForTimeout(700); // past the 500ms save debounce

    // Now select note-beta (this is the action under test).
    await page.goto('/#/note/note-beta');
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('Beta note');

    // Wait past the schedule + debounce window (500ms debounce + 300ms buffer).
    await page.waitForTimeout(800);

    const mtimeAfter = await page.evaluate(() => {
      const notes = (window as any).__testNotes.getAllNotes();
      return notes.find((n: any) => n.id === 'note-beta')?.modificationTime;
    });
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});
