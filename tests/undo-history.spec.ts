import { test, expect, Page } from '@playwright/test';

import { EDITOR, editorMarkdown, waitForEditor, waitForMarkdown } from './lib/desktopEditor';

/**
 * Undo cannot cross a note boundary.
 *
 * The editor keeps ONE undo stack and clears it every time a note is opened
 * (`MilkdownEditor.openNote`), so the only thing these tests can still assert
 * is the data-safety half: an undo pressed in this note can never replay
 * another note's steps into this file, and a note that reuses a deleted note's
 * id starts with a clean stack.
 *
 * The convenience half — each note remembering its own history across a round
 * trip — is GONE with the CodeMirror engine's per-note state stash
 * (`noteHistory.ts`), and is recorded as a Gap in docs/spec/editor.md. The five
 * tests that locked it were deleted with the feature rather than inverted:
 * asserting that undo does nothing would pin the loss in place.
 */

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
  await waitForEditor(page);
  await waitForMarkdown(page, settledDoc);
}

async function pressUndo(page: Page): Promise<void> {
  await page.locator(EDITOR).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
}

/** prosemirror-history merges edits made close together into one undo event. A lower
 * bound on that grouping delay, not a flake cushion. */
async function pauseBeyondHistoryGrouping(page: Page): Promise<void> {
  await page.waitForTimeout(700);
}

/** Type at the end of the open note and wait for the markdown to settle. */
async function appendAndSettle(page: Page, text: string, settled: string): Promise<void> {
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
  await waitForMarkdown(page, settled);
}

test.describe('undo cannot cross a note boundary', () => {
  test('undo in one note never pulls in another note content', async ({ page }) => {
    await waitForApp(page);
    await createTestNote(page, 'Note A', 'alpha');
    await createTestNote(page, 'Note B', 'beta');

    await openNote(page, 'Note A', 'alpha');
    await appendAndSettle(page, ' EDIT-IN-A', 'alpha EDIT-IN-A');
    await pauseBeyondHistoryGrouping(page);

    await openNote(page, 'Note B', 'beta');
    await pauseBeyondHistoryGrouping(page);
    await openNote(page, 'Note A', 'alpha EDIT-IN-A');
    await pauseBeyondHistoryGrouping(page);

    for (let i = 0; i < 5; i += 1) {
      await pressUndo(page);
      expect(await editorMarkdown(page)).not.toContain('beta');
    }
  });

  test('a recreated note does not inherit the deleted note undo history', async ({ page }) => {
    await waitForApp(page);
    await page.waitForSelector('.notes-drawer', { timeout: 10000 });
    await createTestNote(page, 'Recycled', 'SECRET-BODY');

    await openNote(page, 'Recycled', 'SECRET-BODY');
    await appendAndSettle(page, ' X', 'SECRET-BODY X');
    await pauseBeyondHistoryGrouping(page);

    await page.locator('[data-note-id="Recycled"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page
      .getByRole('dialog', { name: 'Delete note' })
      .getByRole('button', { name: 'Confirm' })
      .click();
    await expect(page.locator('[data-note-id="Recycled"]')).toHaveCount(0);

    // Same id, same text — the only thing that can keep them apart is the delete.
    await createTestNote(page, 'Recycled', 'SECRET-BODY X');
    await openNote(page, 'Recycled', 'SECRET-BODY X');

    await pressUndo(page);
    expect(await editorMarkdown(page)).toBe('SECRET-BODY X');
  });
});
