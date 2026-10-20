/**
 * A note with content is never written back empty. → docs/spec/editor.md
 *
 * 2026-09-03: three notes in a live vault were truncated to 0 bytes. Every one
 * of them followed the same shape — the editor was holding an EMPTY document
 * for a note that had content (a hot reload had replaced the component, or the
 * parse had thrown), the session read that `''` as a deletion, and the store
 * wrote it. The two mechanisms are locked at their owning layers
 * (`MilkdownEditor.test.ts`, `noteSession.test.ts`); this is the shell wiring
 * end to end, through the real editor and the real save queue.
 *
 * NOT covered here: the webview `location.reload()` that triggered the third
 * event. The Playwright harness's vault is in-memory (webLocalNoteStore.ts), so
 * a reload wipes the notes rather than re-opening them — that leg needs the
 * real desktop app.
 */

import { expect, test } from '@playwright/test';
import {
  EDITOR,
  clearEditorWithKeyboard,
  openNewNote,
  setEditorMarkdown,
  typeAtCaret,
  waitForEditor,
} from './lib/desktopEditor';
import { NotesHookWindow, storedBody } from './lib/noteNeverEmptied';

const BODY = [
  '# How to Do Great Work',
  '',
  'If you collected lists of techniques for doing great work in a lot of',
  'different fields, what would the intersection look like?',
  '',
  '- one',
  '- two',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
].join('\n');

test.describe('a note with content is never written back empty', () => {
  test('survives being opened, left, and re-opened byte for byte', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openNewNote(page);
    await page.evaluate(
      async ([id, body]) => {
        const w = window as unknown as NotesHookWindow;
        await w.__testNotes.writeNote(id, body);
        await w.__testNotes.writeNote('other note', 'somewhere else\n');
      },
      ['great work', BODY] as const,
    );

    // Open it, leave it for another note, come back.
    await page.evaluate(() => {
      window.location.hash = '#/note/great%20work';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('How to Do Great Work');

    await page.evaluate(() => {
      window.location.hash = '#/note/other%20note';
    });
    await expect(page.locator(EDITOR)).toContainText('somewhere else');

    await page.evaluate(() => {
      window.location.hash = '#/note/great%20work';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('How to Do Great Work');

    // Every save the shell had queued, drained.
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect(await storedBody(page, 'great work')).toBe(BODY);
    expect(pageErrors).toEqual([]);
  });

  /**
   * The read-back half of the first-edit rule for a note that ENDS in a block
   * that is not a paragraph (here a table). Milkdown's `trailing` plugin parks
   * an empty paragraph below it, and the first real edit used to store that as
   * a second trailing newline (RC-22; docs/spec/editor.md: a trailing empty
   * paragraph is dropped on save).
   */
  test('a real edit stores a note that ends in a table with one trailing newline', async ({
    page,
  }) => {
    await openNewNote(page);
    await page.evaluate(
      async ([id, body]) => {
        await (window as unknown as NotesHookWindow).__testNotes.writeNote(id, body);
      },
      ['ends in a table', BODY] as const,
    );
    await page.evaluate(() => {
      window.location.hash = '#/note/ends%20in%20a%20table';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('How to Do Great Work');

    await page.locator(`${EDITOR} h1`).click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    // The body is already in the house style (`| --- |` delimiters), so the
    // keystroke is the only change a first edit makes.
    expect(await storedBody(page, 'ends in a table')).toBe(
      BODY.replace('Great Work', 'Great WorkX'),
    );
  });

  test('a note the user really clears is still emptied', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(async () => {
      await (window as unknown as NotesHookWindow).__testNotes.writeNote('scratch', 'delete me\n');
    });

    await page.evaluate(() => {
      window.location.hash = '#/note/scratch';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('delete me');

    /* Cleared through the shell's own edit path, which notifies the session
     * synchronously. The keyboard route to the same place is asserted below.
     *
     * The point of the assertion is the same either way: the guard that stops a
     * BLANK EDITOR from emptying a note (noteSessionChanges.ts) must not stop
     * the user from emptying one. */
    await setEditorMarkdown(page, '');
    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect((await storedBody(page, 'scratch')).trim()).toBe('');
  });

  /**
   * The keyboard half of the case above, and the one a person actually
   * performs: Ctrl+A, Backspace. It reaches the session by a different route —
   * the editor's debounced change notification rather than `applyEdit` — and
   * that route used to drop the clear entirely, because the change detection it
   * ran on called a cleared note identical to the pristine empty document it
   * was still using as its baseline. → src/features/editor/milkdown/
   * documentChanges.ts
   */
  test('a note the user clears with the keyboard is emptied', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(async () => {
      await (window as unknown as NotesHookWindow).__testNotes.writeNote(
        'typed clear',
        'delete me with the keyboard\n',
      );
    });

    await page.evaluate(() => {
      window.location.hash = '#/note/typed%20clear';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('delete me with the keyboard');

    await clearEditorWithKeyboard(page);

    // The user's own deletion must reach the save queue like any other edit.
    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect((await storedBody(page, 'typed clear')).trim()).toBe('');
  });

  test('clearing with the keyboard and typing again saves what was typed', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(async () => {
      await (window as unknown as NotesHookWindow).__testNotes.writeNote(
        'retyped',
        'the old body\n',
      );
    });

    await page.evaluate(() => {
      window.location.hash = '#/note/retyped';
    });
    await waitForEditor(page);
    await expect(page.locator(EDITOR)).toContainText('the old body');

    await clearEditorWithKeyboard(page);
    await typeAtCaret(page, 'x');

    await page.waitForFunction(
      () => (window as unknown as NotesHookWindow).__notesShellTest.getState().savePending,
    );
    await page.evaluate(() => (window as unknown as NotesHookWindow).__notesShellTest.flushSave());

    expect((await storedBody(page, 'retyped')).trim()).toBe('x');
  });
});
