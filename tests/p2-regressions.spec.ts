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

test.describe('P2 Header + Formatting Regressions', () => {
  test('editor mount applies cm-focused class so the caret is visible', async ({ page }) => {
    // Regression: typing into a freshly-mounted editor used to leave
    // .cm-content as document.activeElement but .cm-editor without the
    // `cm-focused` class — CM6 only renders `.cm-cursor` when that class
    // is present, so the caret was invisible.
    await openNewNote(page);
    await page.evaluate(() => {
      const w = window as typeof window & {
        __notesShellTest: { typeInEditor: (text: string) => string };
      };
      w.__notesShellTest.typeInEditor('- foo');
    });
    await page.waitForTimeout(100);

    const focused = await page
      .locator('.cm-editor')
      .evaluate((el) => el.classList.contains('cm-focused'));
    expect(focused).toBe(true);

    const cursorDisplay = await page.evaluate(() => {
      const c = document.querySelector('.cm-cursor');
      return c ? window.getComputedStyle(c).display : 'missing';
    });
    expect(cursorDisplay).not.toBe('none');
  });

  test('pressing Enter in title moves focus to note body editor', async ({ page }) => {
    await openNewNote(page);

    const titleInput = page.locator('.title-input');
    await titleInput.click();
    await titleInput.fill('My Title');
    await titleInput.press('Enter');

    const editorFocused = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.cm-editor')),
    );
    expect(editorFocused).toBe(true);

    await page.keyboard.type('Body content');
    await expect(page.locator('.cm-content')).toContainText('Body content');
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

    const editor = page.locator('.cm-content');
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
    await page.waitForSelector('.cm-content', { timeout: 10_000 });
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
    await page.locator('.cm-content').click();

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

    await page.locator('.cm-content').click();
    await expect(page.locator('.note-row[data-note-id="Alpha Renamed"]')).toHaveClass(/selected/);

    // The rename bumps mtime, so the row jumps to the top; rows without a
    // selection means the projection and the new id split renders.
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
    await expect(page.locator('.cm-content')).toContainText('body');
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

  // Toggle formatting via CM6 view (toolbar is mobile-only, not available in Playwright)
  async function toggleFormatting(page: Page, fn: string): Promise<void> {
    await page.evaluate((fnName) => {
      const w = window as any;
      const view = w.__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      w.__cmToggle(view, fnName);
    }, fn);
  }

  test('checkbox toggle does not focus editor when it was unfocused', async ({ page }) => {
    await openNewNote(page);

    const editor = page.locator('.cm-content');
    await editor.click();
    await page.keyboard.type('- [ ] Buy milk');

    // Blur the editor so nothing is focused inside it
    await blurEditor(page);

    // Verify editor is not focused
    const focusedBefore = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.cm-editor')),
    );
    expect(focusedBefore).toBe(false);

    // Wait for the checkbox widget to render (editor unfocused → decorations apply)
    const checkbox = page.locator('.cm-md-task-checkbox').first();
    await expect(checkbox).toBeVisible({ timeout: 5000 });

    // Click the checkbox
    await checkbox.click();

    // Wait a tick for any focus side-effects
    await page.waitForTimeout(100);

    // Editor should still NOT be focused
    const focusedAfter = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('.cm-editor')),
    );
    expect(focusedAfter).toBe(false);

    // But the checkbox should have toggled ([ ] → [x])
    const raw = await page.evaluate(() => {
      const w = window as any;
      return w.__cmGetView?.()?.state.doc.toString() ?? '';
    });
    expect(raw).toContain('[x]');
  });

  const formattingCases = [
    { fn: 'bold', cssClass: '.cm-md-strong', sample: 'boldword', marker: '**' },
    { fn: 'italic', cssClass: '.cm-md-emphasis', sample: 'italicword', marker: '*' },
    { fn: 'strikethrough', cssClass: '.cm-md-strikethrough', sample: 'strikeword', marker: '~~' },
  ];

  for (const tc of formattingCases) {
    test(`${tc.fn} keeps trailing space outside closing marker`, async ({ page }) => {
      await openNewNote(page);

      const editor = page.locator('.cm-content');
      await editor.click();

      await toggleFormatting(page, tc.fn);
      await page.keyboard.type(`${tc.sample} `);
      await toggleFormatting(page, tc.fn);
      await page.keyboard.type('tail');

      await blurEditor(page);

      const formatted = page.locator(tc.cssClass).first();
      await expect(formatted).toBeVisible();
      await expect(formatted).toHaveText(tc.sample);

      const visibleText = await editor.textContent();
      expect(visibleText).not.toContain(`${tc.marker}tail`);
    });

    test(`${tc.fn} unwraps when rendered selection includes hidden markers`, async ({ page }) => {
      await openNewNote(page);

      const marked = `${tc.marker}${tc.sample}${tc.marker}`;
      await page.evaluate(
        ({ text }) => {
          const w = window as any;
          const view = w.__cmGetView?.();
          if (!view) throw new Error('CM EditorView not found');
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            selection: { anchor: 0, head: text.length },
          });
        },
        { text: marked },
      );

      await toggleFormatting(page, tc.fn);

      const raw = await page.evaluate(() => {
        const w = window as any;
        return w.__cmGetView?.()?.state.doc.toString() ?? '';
      });
      expect(raw).toBe(tc.sample);
    });
  }

  // Regression: clicking into the body of a tagged note must land the
  // caret at the click point, not at position 0 (inside the hidden
  // header tag block). Position-0 caret was reproducible on Android via
  // a related interaction with the mount-time auto-focus; the desktop
  // assertion here guards against any future regression that surfaces
  // when posAtCoords interacts with the hidden header block.
  test('clicking body of a note with header tags places cursor at the click point', async ({
    page,
  }) => {
    await openNewNote(page);

    const body = 'Body line one\nBody line two\nBody line three\nBody line four';
    await page.evaluate(
      ({ text }) => {
        const w = window as typeof window & {
          __notesShellTest: { seedOpenNote: (id: string, body: string) => void };
        };
        w.__notesShellTest.seedOpenNote('tagged regression', `#alpha #beta\n\n${text}`);
      },
      { text: body },
    );

    // Blur so the header tag block hides — this is the state that breaks
    // coord-to-position mapping in the buggy implementation.
    await blurEditor(page);
    await page.waitForTimeout(200);

    // Sanity: tag pill bar is rendered above the editor.
    await expect(page.locator('.tag-pill').first()).toBeVisible();

    // Click on a known visible line in the body. We pick "Body line three"
    // so the click is well below the (visually collapsed) tag block.
    const targetLine = page.locator('.cm-line', { hasText: 'Body line three' }).first();
    await expect(targetLine).toBeVisible();
    const box = await targetLine.boundingBox();
    if (!box) throw new Error('target line has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(100);

    const cursor = await page.evaluate(() => {
      const view = (window as any).__cmGetView?.();
      if (!view) throw new Error('CM EditorView not found');
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { head, lineNumber: line.number, lineText: line.text };
    });

    // The cursor must land on the line we clicked, not at position 0
    // (which would be inside the hidden `#alpha #beta` tag block).
    expect(cursor.head).toBeGreaterThan(0);
    expect(cursor.lineText).toBe('Body line three');
  });
});
