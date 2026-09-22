import { test, expect, type Page } from '@playwright/test';

import { EDITOR, TYPE_DELAY_MS, openNewNote, waitForMarkdown } from './lib/desktopEditor';

test.describe('P0 Crash and IME Regressions', () => {
  test('backspacing all text then opening menu does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await openNewNote(page);

    const editor = page.locator(EDITOR);
    await editor.click();
    await editor.fill('Temporary text to remove');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await expect(editor).toHaveText('');

    // Desktop layout: sidebar is always visible, no toggle needed.
    // Verify sidebar is present and page didn't crash.
    const aside = page.locator('aside.notes-drawer');
    await expect(aside).toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  test('composition event flow plus sidebar interaction does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await openNewNote(page);

    const editor = page.locator(EDITOR);
    await editor.click();
    await editor.fill('This is **bold** text');
    await page.keyboard.press('Control+End');
    await page.waitForTimeout(150);

    await page.locator('.title-input').click();
    await page.locator('.title-input').blur();
    await page.waitForTimeout(150);

    // Desktop layout: sidebar is always visible. Click a sidebar element
    // to verify no crash during composition.
    await editor.click();
    await editor.evaluate((el) => {
      const event =
        typeof CompositionEvent !== 'undefined'
          ? new CompositionEvent('compositionstart', { bubbles: true, data: 'あ' })
          : new Event('compositionstart', { bubbles: true });
      el.dispatchEvent(event);
    });
    await page.waitForTimeout(100);

    // Click into sidebar area while composition is active
    const aside = page.locator('aside.notes-drawer');
    await aside.click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(100);

    await editor.evaluate((el) => {
      const event =
        typeof CompositionEvent !== 'undefined'
          ? new CompositionEvent('compositionend', { bubbles: true, data: 'あ' })
          : new Event('compositionend', { bubbles: true });
      el.dispatchEvent(event);
    });
    await page.waitForTimeout(100);

    await editor.click();
    await page.keyboard.type('x');
    await expect(editor).toContainText('x');
    expect(pageErrors).toEqual([]);
  });
});

/**
 * A new or blank note must take a caret ANYWHERE in the note area.
 *
 * A brand new note is one empty line at the very top, so almost the entire
 * surface the user sees is the editor's blank tail. If the editable box does
 * not reach the bottom of the note area, every press in that tail lands on a
 * shell element that has no click behaviour of its own — no caret, no focus,
 * no typing — and the note reads as completely dead. docs/spec/editor.md
 * ("Blank editor surface") specifies the opposite: the tail below the final
 * line belongs to the editor and a press there places a caret.
 *
 * → src/features/editor/milkdown/MilkdownEditor.svelte `.ProseMirror`,
 *   docs/spec/editor.md "Blank editor surface"
 */
test.describe('Empty-note caret', () => {
  /**
   * Press in the editor's blank tail — near the BOTTOM of the note area, where
   * a user starting a fresh note naturally clicks — then type.
   *
   * Deliberately not `editor.click()`: that targets the centre of the editable
   * box, which is exactly the region that still worked while the tail was dead.
   */
  async function clickTailAndType(page: Page, text: string): Promise<void> {
    const box = await page.locator('.editor-container').boundingBox();
    if (!box) throw new Error('.editor-container has no box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 24);
    await page.keyboard.type(text, { delay: TYPE_DELAY_MS });
  }

  /**
   * The editable must cover its whole container in BOTH axes, or the space it
   * fails to reach belongs to no one and swallows the press.
   *
   * Two separate rules got this wrong at once on an empty note: the editable
   * ended 256px above the container (content height, `height: auto`) and 788px
   * short of its right edge (a flex item sized to an empty paragraph's content
   * width). Either alone leaves a new note effectively unclickable, so both
   * are asserted.
   */
  async function expectEditableFillsNoteArea(page: Page): Promise<void> {
    const gaps = await page.evaluate(() => {
      const editable = document.querySelector('.ProseMirror');
      const container = document.querySelector('.editor-container');
      if (!editable || !container) return null;
      const inner = editable.getBoundingClientRect();
      const outer = container.getBoundingClientRect();
      return {
        below: Math.round(outer.bottom - inner.bottom),
        right: Math.round(outer.right - inner.right),
      };
    });
    expect(gaps).not.toBeNull();
    expect(gaps?.below).toBeLessThanOrEqual(1);
    expect(gaps?.right).toBeLessThanOrEqual(1);
  }

  test('a brand new note takes a caret in its blank tail', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await openNewNote(page);

    // The document a new note opens with must already hold a textblock, or
    // there is nothing to place a caret in at all.
    const editor = page.locator(EDITOR);
    await expect(editor.locator('> p')).toHaveCount(1);
    await expectEditableFillsNoteArea(page);

    await clickTailAndType(page, 'hello');

    await expect(editor).toContainText('hello');
    await waitForMarkdown(page, 'hello');
    expect(pageErrors).toEqual([]);
  });

  const BLANK_BODIES = [
    ['an empty file', ''],
    ['a file of one newline', '\n'],
    ['a file of only whitespace', '\n  \n\n'],
  ] as const;

  for (const [label, body] of BLANK_BODIES) {
    test(`${label} takes a caret in its blank tail`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => {
        pageErrors.push(error.message);
      });

      await openNewNote(page);
      await page.evaluate((seed) => {
        const w = window as typeof window & {
          __notesShellTest: { seedOpenNote: (id: string, body: string) => void };
        };
        w.__notesShellTest.seedOpenNote('empty-note', seed);
      }, body);
      await page.waitForTimeout(300);

      const editor = page.locator(EDITOR);
      await expect(editor.locator('> p')).toHaveCount(1);
      await expectEditableFillsNoteArea(page);

      await clickTailAndType(page, 'hello');

      await expect(editor).toContainText('hello');
      await waitForMarkdown(page, 'hello');
      expect(pageErrors).toEqual([]);
    });
  }

  test('a short note takes a caret below its last line', async ({ page }) => {
    await openNewNote(page);
    await page.evaluate(() => {
      const w = window as typeof window & {
        __notesShellTest: { seedOpenNote: (id: string, body: string) => void };
      };
      w.__notesShellTest.seedOpenNote('short-note', 'one line');
    });
    await page.waitForTimeout(300);

    await expectEditableFillsNoteArea(page);
    await clickTailAndType(page, ' more');

    await waitForMarkdown(page, 'one line more');
  });
});
