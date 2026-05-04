import { test, expect, type Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

async function seedNote(page: Page, id: string, body: string): Promise<void> {
  await page.evaluate(({ noteId, body }) => {
    const w = window as typeof window & {
      __notesShellTest: {
        seedOpenNote: (id: string, body: string) => void;
      };
    };
    w.__notesShellTest.seedOpenNote(noteId, body);
  }, { noteId: id, body });
  await page.waitForTimeout(300);
}

async function blurEditor(page: Page): Promise<void> {
  await page.locator('.title-input').click();
  await page.locator('.title-input').blur();
  await page.waitForTimeout(300);
}

async function getEditorContent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as any;
    return w.__cmGetView?.()?.state.doc.toString() ?? '';
  });
}

async function createTestNote(page: Page, title: string, body: string): Promise<void> {
  await page.evaluate(
    async ({ title, body }) => {
      const api = (window as any).__testNotes;
      if (!api) throw new Error('__testNotes not available');
      await api.createNote(title, body);
    },
    { title, body },
  );
}

async function refreshNotes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    w.__notesShellTest?.refreshNotes?.();
  });
  await page.waitForTimeout(200);
}

test.describe('Tag System', () => {
  test('NoteTagBar shows tag pills for notes with header tags', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'tagged note', '#recipes #cooking\n\nThis is a recipe note.');

    // Verify editor has our content
    const content = await getEditorContent(page);
    expect(content).toContain('#recipes');

    // Tag bar should be visible with pills
    const tagBar = page.locator('.note-tag-bar');
    await expect(tagBar).toBeVisible({ timeout: 5000 });

    // Should show two tag pills
    const pills = page.locator('.tag-pill');
    await expect(pills).toHaveCount(2, { timeout: 5000 });

    // Should show the "+ Tag" button
    const addBtn = page.locator('.tag-add-btn');
    await expect(addBtn).toBeVisible();
  });

  test('NoteTagBar aligns with the title column', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'aligned tags', '#recipes #cooking\n\nThis is a recipe note.');

    const titleBox = await page.locator('.title-input').boundingBox();
    const firstTagBox = await page.locator('.tag-pill').first().boundingBox();

    expect(titleBox).not.toBeNull();
    expect(firstTagBox).not.toBeNull();

    expect(Math.abs((titleBox?.x ?? 0) - (firstTagBox?.x ?? 0))).toBeLessThanOrEqual(1);
  });

  test('NoteTagBar shows ghost button for notes without tags', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'untagged note', 'Just some plain text.');

    const tagBar = page.locator('.note-tag-bar');
    await expect(tagBar).toBeVisible({ timeout: 5000 });

    // No pills
    const pills = page.locator('.tag-pill');
    await expect(pills).toHaveCount(0);

    // But the add button is there
    const addBtn = page.locator('.tag-add-btn');
    await expect(addBtn).toBeVisible();
  });

  test('Can add a tag via the tag bar input', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'add tag test', 'Some note content here.');

    // Click "+ Tag" button
    await page.locator('.tag-add-btn').click();

    // Input should appear
    const input = page.locator('.tag-input');
    await expect(input).toBeVisible({ timeout: 3000 });

    // Type a tag name and press Enter
    await input.fill('recipes');
    await input.press('Enter');

    // Wait for the editor dispatch + re-render
    await page.waitForTimeout(500);

    // Should now show one tag pill
    const pills = page.locator('.tag-pill');
    await expect(pills).toHaveCount(1, { timeout: 5000 });

    // Verify the editor content was updated
    const content = await getEditorContent(page);
    expect(content).toContain('#recipes');
  });

  test('Can remove a tag via the X button', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'remove tag test', '#recipes #cooking\n\nSome content.');

    // Should start with two pills
    const pills = page.locator('.tag-pill');
    await expect(pills).toHaveCount(2, { timeout: 5000 });

    // Click the X button on the first pill
    await page.locator('.tag-pill-remove').first().click();
    await page.waitForTimeout(500);

    // Should now have one pill
    await expect(pills).toHaveCount(1, { timeout: 5000 });

    // Editor content should have one tag removed
    const content = await getEditorContent(page);
    const tagCount = (content.match(/#(recipes|cooking)/g) || []).length;
    expect(tagCount).toBe(1);
  });

  test('Header tag block is hidden in editor when cursor is not on it', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'hidden tags', '#recipes #cooking\n\nThis is the note body.');
    await blurEditor(page);

    // The visible text in the editor should NOT show raw tag text
    const visibleText = await page.locator('.cm-content').evaluate(
      (el) => (el as HTMLElement).innerText
    );
    expect(visibleText).toContain('This is the note body');
    // Tags should be hidden (shown via pills instead)
    expect(visibleText).not.toContain('#recipes');
  });

  test('Inline tags are styled with cm-md-tag class', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'inline tags', 'This note has an #inline tag in it.');
    await blurEditor(page);

    // Each tag emits two `cm-md-tag` decorations: marker (`#`) + text.
    const marker = page.locator('.cm-md-tag.cm-md-tag-marker');
    const textPart = page.locator('.cm-md-tag.cm-md-tag-text');
    await expect(marker).toBeVisible({ timeout: 5000 });
    await expect(textPart).toBeVisible({ timeout: 5000 });
    await expect(marker).toHaveText('#');
    await expect(textPart).toHaveText('inline');
  });

  test('Tag input shows a Create row when typing a brand-new tag name', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'create affordance', 'Some content.');

    await page.locator('.tag-add-btn').click();
    const input = page.locator('.tag-input');
    await expect(input).toBeVisible({ timeout: 3000 });

    // Type a name that does not match any existing tag.
    await input.fill('travel');
    const createRow = page.locator('.tag-suggestion-create');
    await expect(createRow).toBeVisible({ timeout: 2000 });
    await expect(createRow).toContainText('travel');
  });

  test('Tag input hides the Create row when an existing tag matches exactly', async ({ page }) => {
    await openNewNote(page);
    // Create a note with a #workout tag so #workout is in the existing tag set.
    await createTestNote(page, 'workout seed', '#workout\n\nbody');
    await refreshNotes(page);

    await seedNote(page, 'create hidden when exact', 'Some content.');
    await page.locator('.tag-add-btn').click();
    const input = page.locator('.tag-input');
    await expect(input).toBeVisible({ timeout: 3000 });

    // Exact match: only the suggestion should appear, no Create row.
    await input.fill('workout');
    await expect(page.locator('.tag-suggestion').first()).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.tag-suggestion-create')).toHaveCount(0);
  });

  test('Sidebar tag view shows tags and notes', async ({ page }) => {
    await openNewNote(page);

    // Create notes with tags (stays in memory — no page reload needed)
    await createTestNote(page, 'recipe note', '#recipes\n\nA recipe.');
    await createTestNote(page, 'journal note', '#journal\n\nA journal entry.');

    // Refresh the notes list without reloading the page
    await refreshNotes(page);

    // Click the tag view toggle button
    const tagToggle = page.locator('.sidebar-view-toggle button[aria-label="Tags view"]');
    await expect(tagToggle).toBeVisible({ timeout: 5000 });
    await tagToggle.click();
    await page.waitForTimeout(300);

    // Should show the tag view
    const tagView = page.locator('.sidebar-tag-view');
    await expect(tagView).toBeVisible({ timeout: 5000 });

    // Should show tag headers
    const tagHeaders = page.locator('.sidebar-tag-header');
    await expect(tagHeaders).toHaveCount(2, { timeout: 5000 });
  });
});
