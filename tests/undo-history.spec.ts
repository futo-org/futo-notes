import { test, expect, Page } from '@playwright/test';

async function waitForApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => !!(window as any).__testNotes, null, { timeout: 10000 });
}

async function createTestNote(page: Page, title: string, body: string): Promise<void> {
  await page.evaluate(
    async ({ title, body }) => {
      const api = (window as any).__testNotes;
      if (!api) throw new Error('__testNotes not available — is dev mode running?');
      await api.createNote(title, body);
    },
    { title, body },
  );
}

/** In-app switch: a `page.goto` to a new hash reloads and discards history, masking what
 * these tests check. Settles on the exact document so a keystroke can't land mid-switch. */
async function openNote(page: Page, id: string, settledDoc: string): Promise<void> {
  await page.evaluate((noteId) => {
    window.location.hash = `#/note/${encodeURIComponent(noteId)}`;
  }, id);
  await page.waitForSelector('.cm-content', { timeout: 10000 });
  await page.waitForFunction(
    (expected) => (window as any).__cmGetView?.()?.state.doc.toString() === expected,
    settledDoc,
    { timeout: 10000 },
  );
}

async function readDoc(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__cmGetView?.().state.doc.toString() ?? '');
}

async function pressUndo(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__cmGetView?.().focus());
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
}

/** CodeMirror merges edits made within `newGroupDelay` (500ms) into one undo event. A
 * lower bound on that constant, not a flake cushion. */
async function pauseBeyondHistoryGrouping(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

async function setUpTwoNotes(page: Page): Promise<void> {
  await waitForApp(page);
  await createTestNote(page, 'Note A', 'alpha');
  await createTestNote(page, 'Note B', 'beta');

  await openNote(page, 'Note A', 'alpha');
  await page.evaluate(() => (window as any).__cmGetView?.().focus());
  await page.keyboard.press('End');
  await page.keyboard.type(' EDIT-IN-A');
  await page.waitForFunction(
    () => (window as any).__cmGetView?.()?.state.doc.toString() === 'alpha EDIT-IN-A',
    null,
    { timeout: 10000 },
  );
  await pauseBeyondHistoryGrouping(page);

  await openNote(page, 'Note B', 'beta');
  await pauseBeyondHistoryGrouping(page);
  await openNote(page, 'Note A', 'alpha EDIT-IN-A');
  await pauseBeyondHistoryGrouping(page);
}

test.describe('undo history is per note', () => {
  test('undo in one note never pulls in another note content', async ({ page }) => {
    await setUpTwoNotes(page);

    for (let i = 0; i < 5; i += 1) {
      await pressUndo(page);
      expect(await readDoc(page)).not.toContain('beta');
    }
  });

  test('a note keeps its own undo history across a round trip', async ({ page }) => {
    await setUpTwoNotes(page);

    await pressUndo(page);
    expect(await readDoc(page)).toBe('alpha');
  });

  // Guards that the stash/restore is synchronous — it must not depend on the user pausing.
  test('switching as fast as possible keeps each note history', async ({ page }) => {
    await waitForApp(page);
    await createTestNote(page, 'Note A', 'alpha');
    await createTestNote(page, 'Note B', 'beta');

    await openNote(page, 'Note A', 'alpha');
    await page.evaluate(() => (window as any).__cmGetView?.().focus());
    await page.keyboard.press('End');
    await page.keyboard.type(' EDIT-IN-A');
    await page.waitForFunction(
      () => (window as any).__cmGetView?.()?.state.doc.toString() === 'alpha EDIT-IN-A',
      null,
      { timeout: 10000 },
    );

    await openNote(page, 'Note B', 'beta');
    await openNote(page, 'Note A', 'alpha EDIT-IN-A');

    await pressUndo(page);
    expect(await readDoc(page)).toBe('alpha');
  });

  test('renaming a note keeps its undo history', async ({ page }) => {
    await waitForApp(page);
    await createTestNote(page, 'Before Rename', 'alpha');
    await createTestNote(page, 'Elsewhere', 'beta');

    await openNote(page, 'Before Rename', 'alpha');
    await page.evaluate(() => (window as any).__cmGetView?.().focus());
    await page.keyboard.press('End');
    await page.keyboard.type(' EDIT');
    await page.waitForFunction(
      () => (window as any).__cmGetView?.()?.state.doc.toString() === 'alpha EDIT',
      null,
      { timeout: 10000 },
    );

    const title = page.locator('.title-input');
    await title.fill('After Rename');
    await title.press('Enter');
    await expect(page.locator('[data-note-id="After Rename"]')).toHaveCount(1, { timeout: 10000 });

    // Leaving and returning is what forces the stash to be used: a rename alone never
    // rebuilds the editor, so the live history would answer and prove nothing.
    await openNote(page, 'Elsewhere', 'beta');
    await openNote(page, 'After Rename', 'alpha EDIT');

    await pressUndo(page);
    expect(await readDoc(page)).toBe('alpha');
  });

  test('a note keeps its undo history across a trip back to the note list', async ({ page }) => {
    await waitForApp(page);
    await createTestNote(page, 'Note A', 'alpha');

    await openNote(page, 'Note A', 'alpha');
    await page.evaluate(() => (window as any).__cmGetView?.().focus());
    await page.keyboard.press('End');
    await page.keyboard.type(' EDIT-IN-A');
    await page.waitForFunction(
      () => (window as any).__cmGetView?.()?.state.doc.toString() === 'alpha EDIT-IN-A',
      null,
      { timeout: 10000 },
    );
    await pauseBeyondHistoryGrouping(page);

    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await page.waitForFunction(
      () => (window as any).__cmGetView?.()?.state.doc.toString() === '',
      null,
      { timeout: 10000 },
    );
    await openNote(page, 'Note A', 'alpha EDIT-IN-A');

    await pressUndo(page);
    expect(await readDoc(page)).toBe('alpha');
  });

  test('a recreated note does not inherit the deleted note undo history', async ({ page }) => {
    await waitForApp(page);
    await page.waitForSelector('.notes-drawer', { timeout: 10000 });
    page.on('dialog', (dialog) => dialog.accept());
    await createTestNote(page, 'Recycled', 'SECRET-BODY');

    await openNote(page, 'Recycled', 'SECRET-BODY');
    await page.evaluate(() => (window as any).__cmGetView?.().focus());
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    await page.waitForFunction(
      () => (window as any).__cmGetView?.()?.state.doc.toString() === 'SECRET-BODY X',
      null,
      { timeout: 10000 },
    );
    await pauseBeyondHistoryGrouping(page);

    await page.locator('[data-note-id="Recycled"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('[data-note-id="Recycled"]')).toHaveCount(0);

    // Same id, same text — the only thing that can keep them apart is the delete.
    await createTestNote(page, 'Recycled', 'SECRET-BODY X');
    await openNote(page, 'Recycled', 'SECRET-BODY X');

    await pressUndo(page);
    expect(await readDoc(page)).toBe('SECRET-BODY X');
  });

  test('surviving a burst of rapid switches', async ({ page }) => {
    await waitForApp(page);
    await createTestNote(page, 'Note A', 'alpha');
    await createTestNote(page, 'Note B', 'beta');

    await openNote(page, 'Note A', 'alpha');
    await page.evaluate(() => (window as any).__cmGetView?.().focus());
    await page.keyboard.press('End');
    await page.keyboard.type(' EDIT-IN-A');
    await page.waitForFunction(
      () => (window as any).__cmGetView?.()?.state.doc.toString() === 'alpha EDIT-IN-A',
      null,
      { timeout: 10000 },
    );

    for (let i = 0; i < 5; i += 1) {
      await openNote(page, 'Note B', 'beta');
      await openNote(page, 'Note A', 'alpha EDIT-IN-A');
    }

    await pressUndo(page);
    expect(await readDoc(page)).toBe('alpha');
  });
});
