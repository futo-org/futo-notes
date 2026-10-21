import { expect, test, type Page } from '@playwright/test';

import { openNewNoteInPlace, typeInEditor } from './lib/desktopEditor';

/**
 * A duplicate title blocks the rename, never the body. → docs/spec/editor.md
 *
 * 2026-10-20 (QA report): a new note titled like an existing one showed the
 * warning, then lost its body when the user clicked away; and `Test` beside
 * `test` got no warning at all, the store quietly saving it as `Test-2`.
 */
interface NotesHookWindow extends Window {
  __testNotes: {
    createNote: (id: string, content: string) => Promise<unknown>;
    readNote: (id: string) => Promise<string>;
    listNoteFiles: () => Promise<Array<{ name: string; size: number }>>;
  };
}

async function noteFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await (window as unknown as NotesHookWindow).__testNotes.listNoteFiles())
      .map((file) => file.name)
      .sort(),
  );
}

async function newNoteBeside(page: Page, title: string, body: string): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
  await page.evaluate(() =>
    (window as unknown as NotesHookWindow).__testNotes.createNote('test', 'body one\n'),
  );
  await expect(page.locator('[data-note-id="test"]')).toBeVisible();
  await openNewNoteInPlace(page);
  await page.locator('.title-input').pressSequentially(title);
  await typeInEditor(page, body);
}

test.describe('a duplicate title', () => {
  test('keeps the body of a new note the user clicks away from', async ({ page }) => {
    await newNoteBeside(page, 'test', 'body two');
    await expect(page.locator('.title-warning')).toHaveText('A note with this name already exists');

    await page.locator('[data-note-id="test"]').click();

    await expect.poll(() => noteFiles(page)).toEqual(['Untitled.md', 'test.md']);
    const stored = (id: string) =>
      page.evaluate(
        (noteId) => (window as unknown as NotesHookWindow).__testNotes.readNote(noteId),
        id,
      );
    expect(await stored('Untitled')).toContain('body two');
    expect(await stored('test')).toBe('body one\n');
  });

  test('that differs only in case is refused too', async ({ page }) => {
    await newNoteBeside(page, 'Test', 'body two');
    await expect(page.locator('.title-warning')).toHaveText('A note with this name already exists');

    await page.locator('[data-note-id="test"]').click();

    await expect.poll(() => noteFiles(page)).toEqual(['Untitled.md', 'test.md']);
  });
});
