import { test, expect, Page } from '@playwright/test';

import {
  EDITOR,
  editorMarkdown,
  openNewNote,
  typeInEditor,
  waitForEditor,
} from './lib/desktopEditor';

/**
 * P2 regressions: title/rename commit behaviour, and the task checkbox.
 *
 * Deleted with the CodeMirror engine, along with the spec lines they locked:
 *
 * - `editor mount applies cm-focused class so the caret is visible`. The class
 *   was CodeMirror's, and the editor no longer focuses itself on mount on any
 *   surface (docs/spec/nav.md), so there is no mount-time focus to assert. What
 *   survives — the app's own focus reporting — is
 *   `tests/editor-focus-signal.spec.ts`.
 * - The six bold/italic/strikethrough cases. They drove `window.__cmToggle`
 *   and asserted on markdown SOURCE: that a trailing space stays outside the
 *   closing `**`, and that a selection covering hidden `**` markers unwraps.
 *   Neither has a WYSIWYG meaning — a mark is toggled on a selection and there
 *   are no markers to include. Toolbar command behaviour is covered by
 *   `tests/editor-embed-milkdown-toolbar.spec.ts`.
 * - `clicking body of a note with header tags places cursor at the click
 *   point`. It depended on the header tag block being HIDDEN while the editor
 *   is blurred; the WYSIWYG editor renders it as ordinary text (a recorded Gap
 *   in docs/spec/editor.md), so the state the regression needed cannot be set
 *   up.
 */

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

    const editorFocused = await page.evaluate(
      (selector) => Boolean(document.activeElement?.closest(selector)),
      EDITOR,
    );
    expect(editorFocused).toBe(true);

    await page.keyboard.type('Body content');
    await expect(page.locator(EDITOR)).toContainText('Body content');
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
        end: input.selectionEnd,
      };
    });

    expect(selection.start).toBe(selection.end);
  });

  test('titles ending with a dot show an inline warning', async ({ page }) => {
    await openNewNote(page);

    const titleInput = page.locator('.title-input');
    await titleInput.click();
    await titleInput.fill('bad.');

    const editor = page.locator(EDITOR);
    await editor.click();
    await page.keyboard.type('Body content');

    await expect(page.locator('text=Title cannot end with a dot')).toBeVisible();
  });

  async function openNoteForRetitle(page: Page, id: string): Promise<void> {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
    await page.evaluate(async (noteId) => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote(noteId, 'body');
    }, id);
    await page.locator(`.note-row[data-note-id="${id}"]`).click();
    await waitForEditor(page);
    await page.locator('.title-input').click();
  }

  test('pressing Enter in the title commits the rename to the sidebar', async ({ page }) => {
    await openNoteForRetitle(page, 'Enter Note');
    await page.locator('.title-input').fill('Enter Renamed');
    await page.keyboard.press('Enter');

    await expect(page.locator('.note-row[data-note-id="Enter Renamed"]')).toHaveText(
      'Enter Renamed',
    );
    await expect(page.locator('.note-row[data-note-id="Enter Note"]')).toHaveCount(0);
  });

  test('clicking out of the title commits the rename to the sidebar', async ({ page }) => {
    await openNoteForRetitle(page, 'Click Note');
    await page.locator('.title-input').fill('Click Renamed');
    await page.locator(EDITOR).click();

    await expect(page.locator('.note-row[data-note-id="Click Renamed"]')).toHaveText(
      'Click Renamed',
    );
    await expect(page.locator('.note-row[data-note-id="Click Note"]')).toHaveCount(0);
  });

  test('clicking off the title onto inert chrome commits the rename', async ({ page }) => {
    await openNoteForRetitle(page, 'Inert Note');
    await page.locator('.title-input').fill('Inert Renamed');

    await page.locator('.drawer-search-area').click();

    await expect(page.locator('.note-row[data-note-id="Inert Renamed"]')).toHaveCount(1);
    await expect(page.locator('.note-row[data-note-id="Inert Note"]')).toHaveCount(0);
  });

  test('the open note never loses its selection while the rename re-sorts', async ({ page }) => {
    await openNoteForRetitle(page, 'Alpha');
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Beta', 'body');
      await win.__testNotes.createNote('Gamma', 'body');
    });
    await page.locator('.title-input').click();
    await page.locator('.title-input').fill('Alpha Renamed');

    await page.evaluate(() => {
      const states: Array<{ rows: number; selected: number }> = [];
      (window as unknown as { __states: typeof states }).__states = states;
      const record = (): void => {
        const rows = document.querySelectorAll('.note-row');
        states.push({
          rows: rows.length,
          selected: document.querySelectorAll('.note-row.selected').length,
        });
      };
      new MutationObserver(record).observe(document.querySelector('.folder-tree-scroll')!, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'data-note-id'],
      });
      record();
    });

    await page.locator(EDITOR).click();
    await expect(page.locator('.note-row[data-note-id="Alpha Renamed"]')).toHaveClass(/selected/);

    // Rows present but none selected = the projection and the new id split renders.
    const states = await page.evaluate(
      () => (window as unknown as { __states: Array<{ rows: number; selected: number }> }).__states,
    );
    expect(states.length).toBeGreaterThan(1);
    expect(states.filter((s) => s.rows > 0 && s.selected === 0)).toEqual([]);
  });

  test('renaming then clicking straight to another note commits and switches', async ({ page }) => {
    await openNoteForRetitle(page, 'Switch Note');
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Neighbour', 'other body');
    });
    await page.locator('.title-input').click();
    await page.locator('.title-input').fill('Switch Renamed');

    await page.locator('.note-row[data-note-id="Neighbour"]').click();

    await expect(page.locator('.note-row[data-note-id="Switch Renamed"]')).toHaveCount(1);
    await expect(page.locator('.note-row[data-note-id="Switch Note"]')).toHaveCount(0);
    await expect(page.locator('.title-input')).toHaveValue('Neighbour');
  });

  test('a renamed note reopens on the first click after switching away', async ({ page }) => {
    await openNoteForRetitle(page, 'Reopen Note');
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Other', 'other body');
    });
    await page.locator('.title-input').click();
    await page.locator('.title-input').fill('Reopen Renamed');

    await page.locator('.note-row[data-note-id="Other"]').click();
    await expect(page.locator('.title-input')).toHaveValue('Other');

    await page.locator('.note-row[data-note-id="Reopen Renamed"]').click();
    await expect(page.locator('.title-input')).toHaveValue('Reopen Renamed');
    await expect(page.locator(EDITOR)).toContainText('body');
    await expect(page.locator('.note-row[data-note-id="Reopen Renamed"]')).toHaveClass(/selected/);
  });

  test('navigating Home still commits a pending rename', async ({ page }) => {
    await openNoteForRetitle(page, 'Home Note');
    await page.locator('.title-input').fill('Home Renamed');

    await page.locator('.brand-text').click();

    await expect(page.locator('.note-row[data-note-id="Home Renamed"]')).toHaveCount(1);
    await expect(page.locator('.note-row[data-note-id="Home Note"]')).toHaveCount(0);
  });

  test('dragging a renamed note into a folder still moves it', async ({ page }) => {
    await openNoteForRetitle(page, 'Drag Note');
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Work/placeholder', 'body');
    });
    await page.locator('.title-input').click();
    await page.locator('.title-input').fill('Drag Renamed');

    const row = await page.locator('.note-row[data-note-id="Drag Note"]').boundingBox();
    const folder = await page.locator('[data-folder-path="Work"]').first().boundingBox();
    if (!row || !folder) throw new Error('setup: missing note row or folder row');

    // Must be pointer-driven: synthetic DragEvents fire no pointercancel.
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step++) {
      await page.mouse.move(
        row.x + row.width / 2 + ((folder.x - row.x) * step) / 12,
        row.y + row.height / 2 + ((folder.y - row.y) * step) / 12,
      );
      // Duration is input, not a condition wait: a real drag outlasts the deferral.
      await page.waitForTimeout(30);
    }
    await page.mouse.up();

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const win = window as unknown as {
            __testNotes: { getAllNotes: () => Array<{ id: string }> };
          };
          return win.__testNotes.getAllNotes().map((note) => note.id);
        }),
      )
      .toContain('Work/Drag Renamed');
  });

  test('checkbox toggle does not focus editor when it was unfocused', async ({ page }) => {
    await openNewNote(page);

    // Typed at human cadence: `- [ ] ` is an input rule, and a zero-delay
    // `type()` outruns the transaction that turns it into a task item.
    await typeInEditor(page, '- [ ] Buy milk');

    // Blur the editor so nothing is focused inside it
    await blurEditor(page);

    const isEditorFocused = () =>
      page.evaluate((selector) => Boolean(document.activeElement?.closest(selector)), EDITOR);
    expect(await isEditorFocused()).toBe(false);

    // The checkbox is a node-view widget that owns its own taps (taskCheckbox.ts).
    const checkbox = page.locator(`${EDITOR} .futo-task-checkbox`).first();
    await expect(checkbox).toBeVisible({ timeout: 5000 });

    await checkbox.click();
    await page.waitForTimeout(100);

    // Toggling must not steal focus back into the editor...
    expect(await isEditorFocused()).toBe(false);
    // ...but it must have toggled the item, in the note that gets saved.
    expect(await editorMarkdown(page)).toContain('[x]');
  });
});
