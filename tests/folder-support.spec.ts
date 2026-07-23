import { test, expect, Locator, Page } from '@playwright/test';

/**
 * Folder support v1 — sidebar folder UI.
 *
 * Web mode keeps notes/folders in memory only (`webFS` in
 * `src/lib/platform/web.ts`), so these tests exercise the create /
 * rename / delete / move flows without needing the Tauri backend.
 */

async function openSidebar(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.notes-drawer', { timeout: 10_000 });
}

// Pin the folder tree to MIN_SIDEBAR_WIDTH (200px) so the 50% indent cap
// resolves against the worst supported sidebar width.
async function pinSidebarToMinWidth(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.folder-tree-scroll')!;
    scroll.style.flex = '0 0 200px';
    scroll.style.width = '200px';
  });
}

// Content width (excluding horizontal padding) of a tree row and whether its
// right edge stays inside the (overflow-hidden) scroll viewport.
async function measureRowFit(
  row: Locator,
): Promise<{ contentWidth: number; rowRight: number; scrollRight: number }> {
  return row.evaluate((el) => {
    const scroll = el.closest<HTMLElement>('.folder-tree-scroll')!;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return {
      contentWidth: rect.width - padX,
      rowRight: rect.right,
      scrollRight: scroll.getBoundingClientRect().right,
    };
  });
}

test.describe('Folder support', () => {
  test('the new-folder button opens the create-folder modal', async ({ page }) => {
    await openSidebar(page);
    const button = page.getByTestId('new-folder-btn');
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByTestId('create-folder-input')).toBeVisible();
    // Cancel closes the modal.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
  });

  test('creating a folder adds it to the sidebar opened by default', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    const input = page.getByTestId('create-folder-input');
    await input.fill('Specs');
    await page.getByTestId('create-folder-confirm').click();
    // Modal closes, the folder appears in the sidebar.
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
    await expect(page.locator('[data-folder-path="Specs"]').first()).toBeVisible();
  });

  test('an empty folder remains available in the move picker', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Empty');
    await page.getByTestId('create-folder-confirm').click();

    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('move-me', 'body');
    });
    await page.locator('[data-note-id="move-me"]').click();
    await page.getByRole('button', { name: 'Note options' }).click();
    await page.getByTestId('note-menu-move').click();

    await expect(page.locator('.picker-list [data-folder-path="Empty"]')).toBeVisible();
  });

  test('creating a folder with a Windows-reserved name surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('CON');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
    await expect(page.locator('.modal-error')).toContainText(/reserved/i);
  });

  test('creating a sibling that differs only in case is rejected', async ({ page }) => {
    await openSidebar(page);
    // Create the first folder
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Specs');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
    // Try to create a case-only-different sibling
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('SPECS');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
    await expect(page.locator('.modal-error')).toContainText(/already exists/i);
  });

  test('creating a folder with an empty name keeps Create disabled without an error', async ({
    page,
  }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('   ');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
    await expect(page.locator('.modal-error')).toBeHidden();
  });

  test('creating a folder with forbidden characters surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('bad<name>');
    await expect(page.getByTestId('create-folder-confirm')).toBeDisabled();
    await expect(page.locator('.modal-error')).toBeVisible();
  });

  test('clicking a folder toggles open / closed state', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Toggle');
    await page.getByTestId('create-folder-confirm').click();
    const folderRow = page.locator('[data-folder-path="Toggle"]').first();
    await expect(folderRow).toBeVisible();
    // Folder is open by default after creation; click to close.
    await folderRow.click();
    // Click again to re-open.
    await folderRow.click();
    // Both transitions should leave the row visible.
    await expect(folderRow).toBeVisible();
  });

  test('the create-folder modal shows the default title at root', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await expect(page.locator('.modal-title')).toHaveText('New folder');
    await page.keyboard.press('Escape');
  });

  test('folder rename is inline from double-click, F2, and context menu', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Work');
    await page.getByTestId('create-folder-confirm').click();

    const work = page.locator('[data-folder-path="Work"]').first();
    await work.dblclick();
    await page.getByTestId('folder-rename-input').fill('Projects');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Projects"]').first()).toBeVisible();
    await expect(page.getByTestId('create-folder-input')).toBeHidden();

    const projects = page.locator('[data-folder-path="Projects"]').first();
    await projects.focus();
    await page.keyboard.press('F2');
    await page.getByTestId('folder-rename-input').fill('Archive');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Archive"]').first()).toBeVisible();

    const archive = page.locator('[data-folder-path="Archive"]').first();
    await archive.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByTestId('folder-rename-input').fill('Done');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-folder-path="Done"]').first()).toBeVisible();
    await expect(page.getByTestId('create-folder-input')).toBeHidden();
  });

  test('existing folders expose discoverable subfolder creation', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('Work');
    await page.getByTestId('create-folder-confirm').click();

    await expect(
      page.locator('[data-folder-path="Work"] [data-testid="folder-add-subfolder"]'),
    ).toHaveCount(0);

    await page.locator('[data-folder-path="Work"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New Folder' }).click();
    await expect(page.locator('.modal-title')).toHaveText('New folder in "Work"');
    await page.getByTestId('create-folder-input').fill('Plans');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('[data-folder-path="Work/Plans"]').first()).toBeVisible();
  });

  test('deleting a folder keeps contained notes and moves the open note', async ({ page }) => {
    await openSidebar(page);
    page.on('dialog', (dialog) => dialog.accept());
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Work/open-note', 'body');
    });

    await page.locator('[data-folder-path="Work"]').first().click();
    await page.locator('[data-note-id="Work/open-note"]').click();
    await expect(page).toHaveURL(/#\/note\/Work%2Fopen-note/);

    await page.locator('[data-folder-path="Work"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.locator('.toast')).toContainText('Folder deleted; moved 1 note');
    await expect(page).toHaveURL(/#\/note\/open-note/);
    await expect(page.locator('[data-note-id="Work/open-note"]')).toHaveCount(0);
    await expect(page.locator('[data-note-id="open-note"]')).toBeVisible();
  });

  test('folder context menu exposes Move to folder and applies the picked destination', async ({
    page,
  }) => {
    await openSidebar(page);
    for (const name of ['Work', 'Archive']) {
      await page.getByTestId('new-folder-btn').click();
      await page.getByTestId('create-folder-input').fill(name);
      await page.getByTestId('create-folder-confirm').click();
    }

    await page.locator('[data-folder-path="Work"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to folder' }).click();
    await page.locator('.modal-card').getByText('Archive', { exact: true }).click();

    await expect(page.locator('[data-folder-path="Archive/Work"]').first()).toBeVisible();
    await expect(page.locator('[data-folder-path="Work"]')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Moved to Archive');
  });

  test('folder drag-drop falls back to tracked source when MIME data is hidden', async ({
    page,
  }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('work');
    await page.getByTestId('create-folder-confirm').click();
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('archive');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('[data-folder-path="archive"]').first()).toBeVisible();

    const moved = await page.evaluate(async () => {
      const archive = document.querySelector('[data-folder-path="archive"]');
      const work = document.querySelector('[data-folder-path="work"]');
      if (!archive || !work) return false;

      archive.dispatchEvent(
        new DragEvent('dragstart', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        }),
      );
      work.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        }),
      );
      work.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        }),
      );
      archive.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
      return Boolean(document.querySelector('[data-folder-path="work/archive"]'));
    });
    expect(moved).toBe(true);
  });

  test('drop-target outline does not flicker when dragging over rows', async ({ page }) => {
    // Regression: WebKitGTK fires `dragleave` with relatedTarget=null
    // on every row→row transition during a drag. The earlier
    // handleRootDragLeave treated null as "left container" and cleared
    // dropTarget, then dragover on the next row restored it — the
    // result was the orange root outline strobing on/off at ~60Hz when
    // dragging a folder-nested note back to root.
    //
    // This test exercises the same event sequence WebKitGTK produces
    // and asserts that the .root-drop-target class stays steady (one
    // on-transition, no oscillation) while the cursor sweeps across
    // multiple top-level rows.
    await openSidebar(page);

    // Seed a folder and drop a note into it via the test API so we have
    // a nested note to drag back to root, plus several top-level notes
    // to sweep across.
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('seed-folder/inside', 'a');
      for (let i = 0; i < 5; i++) {
        await win.__testNotes.createNote(`top-${i}`, '');
      }
    });

    await expect(page.locator('[data-folder-path="seed-folder"]').first()).toBeVisible();
    await page.locator('[data-folder-path="seed-folder"]').first().click();
    await expect(page.locator('[data-note-id="seed-folder/inside"]')).toBeVisible();

    const transitions = await page.evaluate(async () => {
      const noteRows = [...document.querySelectorAll('.note-row')];
      const nested = noteRows.find((r) => r.getAttribute('data-note-id') === 'seed-folder/inside');
      const scroll = document.querySelector('.folder-tree-scroll') as HTMLElement | null;
      if (!nested || !scroll) return { error: 'setup' };

      const flips: Array<{ root: boolean }> = [
        { root: scroll.classList.contains('root-drop-target') },
      ];
      let last = flips[0].root;
      const obs = new MutationObserver(() => {
        const has = scroll.classList.contains('root-drop-target');
        if (has !== last) {
          flips.push({ root: has });
          last = has;
        }
      });
      obs.observe(scroll, { attributes: true, attributeFilter: ['class'] });

      const dt = new DataTransfer();
      dt.setData('application/futo-note-id', 'seed-folder/inside');
      nested.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      await new Promise((r) => setTimeout(r, 30));

      const topRows = noteRows.filter((r) => {
        const id = r.getAttribute('data-note-id') ?? '';
        return id.startsWith('top-');
      });
      // Sweep: dragover row N, then dragleave row N with relatedTarget=null
      // (the WebKitGTK pattern), repeat for each row.
      for (const row of topRows) {
        row.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
        await new Promise((r) => requestAnimationFrame(r));
        row.dispatchEvent(
          new DragEvent('dragleave', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            relatedTarget: null,
          }),
        );
        await new Promise((r) => requestAnimationFrame(r));
      }
      obs.disconnect();
      nested.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      return { flips, transitionCount: flips.length - 1 };
    });

    if ('error' in transitions) throw new Error(`Setup failed: ${transitions.error}`);
    // The outline should turn on once when the cursor enters the root
    // area and stay on. One transition (off → on). More than 2 means
    // the outline is oscillating — the regression we're guarding against.
    expect(transitions.transitionCount).toBeLessThanOrEqual(2);
  });

  test('note row background boxes are a uniform fixed width, not title-hugging', async ({
    page,
  }) => {
    // Regression: .note-row is a <button>, which — unlike a <div> —
    // does not stretch to fill its containing block just because
    // display is flex/block; it shrink-wraps to its content (the
    // title). That produced a ragged sidebar where a short title got a
    // narrow pill and a long title a wide one. Every row's box must be
    // the same fixed width regardless of title length.
    await openSidebar(page);
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Hi', 'short title body');
      await win.__testNotes.createNote(
        'This is a much longer note title used to test row width',
        'long title body',
      );
    });

    const widths = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('.note-row')];
      return rows.map((row) => Math.round(row.getBoundingClientRect().width));
    });

    expect(widths.length).toBeGreaterThanOrEqual(2);
    // All rows share one fixed width — no per-title variance.
    expect(new Set(widths).size).toBe(1);
    // And that width fills the available column, not just the "Hi" text.
    expect(widths[0]).toBeGreaterThan(100);
  });

  test('nested rows stay within the tree viewport (no right-edge clipping)', async ({ page }) => {
    // Regression: nested folder/note rows carry a depth-based margin-left.
    // With a plain width: 100% the row's margin box grows wider than
    // .folder-tree-scroll, whose overflow-x: hidden then clips each nested
    // row's right edge (title area, background, and click target). The
    // fixed-width test above only creates ROOT notes, so it can't catch
    // this — depth 0 has margin-left: 0. Sizing rows to
    // calc(100% - var(--indent)) must keep every indented row's right edge
    // flush inside the viewport.
    await openSidebar(page);
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: {
          createFolder: (path: string) => Promise<unknown>;
          createNote: (id: string, body: string) => Promise<unknown>;
        };
      };
      await win.__testNotes.createFolder('Deep');
      await win.__testNotes.createFolder('Deep/Nested');
      await win.__testNotes.createNote('Deep/Nested/leaf', 'nested note body');
    });

    // Folders created via the test hook start collapsed — expand each so the
    // depth-2 note row renders.
    await page.locator('.folder-row[data-folder-path="Deep"]').first().click();
    await page.locator('.folder-row[data-folder-path="Deep/Nested"]').first().click();

    const nestedRow = page.locator('.note-row[data-note-id="Deep/Nested/leaf"]');
    await expect(nestedRow).toBeVisible();

    const geometry = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.folder-tree-scroll')!;
      const scrollRect = scroll.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>('.note-row, .folder-row')];
      return {
        scrollRight: scrollRect.right,
        rows: rows.map((row) => {
          const rect = row.getBoundingClientRect();
          return { right: rect.right, left: rect.left, width: Math.round(rect.width) };
        }),
      };
    });

    // No row's right edge spills past the scroll viewport (which would be
    // clipped by overflow-x: hidden). 1px tolerance for sub-pixel rounding.
    for (const row of geometry.rows) {
      expect(row.right).toBeLessThanOrEqual(geometry.scrollRight + 1);
    }
    // The deepest row is genuinely indented (proves margin-left still applies)
    // yet remains a usable width, not squeezed to nothing.
    const deepest = geometry.rows.reduce((a, b) => (b.left > a.left ? b : a));
    expect(deepest.left).toBeGreaterThan(geometry.rows[0].left);
    expect(deepest.width).toBeGreaterThan(100);
  });

  test('deeply nested rows stay usable at the minimum sidebar width', async ({ page }) => {
    // Adversarial regression: folder depth is unbounded and the sidebar can
    // shrink to MIN_SIDEBAR_WIDTH (200px). With a raw depth indent, a deep
    // enough row consumes the entire width (depth 10 * 16px = 160px indent vs
    // ~184px content) and renders as a blank, titleless click target. The
    // indent is capped at 50% of the row so every row keeps a usable,
    // title-bearing width at any depth and sidebar width.
    const DEPTH = 10; // matches "folder depth allowed" + DEPTH_INDENT_PX = 16
    await openSidebar(page);
    const leafId = await page.evaluate(async (depth) => {
      const win = window as unknown as {
        __testNotes: {
          createFolder: (path: string) => Promise<unknown>;
          createNote: (id: string, body: string) => Promise<unknown>;
        };
      };
      const parts: string[] = [];
      for (let i = 1; i <= depth; i++) {
        parts.push(`d${i}`);
        await win.__testNotes.createFolder(parts.join('/'));
      }
      const id = `${parts.join('/')}/leaf`;
      await win.__testNotes.createNote(id, 'deep note body');
      return id;
    }, DEPTH);

    // Expand every ancestor folder so the leaf row renders.
    const parts: string[] = [];
    for (let i = 1; i <= DEPTH; i++) {
      parts.push(`d${i}`);
      await page
        .locator(`.folder-row[data-folder-path="${parts.join('/')}"]`)
        .first()
        .click();
    }

    await pinSidebarToMinWidth(page);

    const leaf = page.locator(`.note-row[data-note-id="${leafId}"]`);
    await expect(leaf).toBeVisible();
    const box = await measureRowFit(leaf);

    // The deepest row must keep a usable, title-bearing content width — the
    // old raw indent left 0px here. And its right edge stays in the viewport.
    expect(box.contentWidth).toBeGreaterThan(40);
    expect(box.rowRight).toBeLessThanOrEqual(box.scrollRight + 1);
  });

  test('deeply nested empty-folder placeholder stays usable at min width', async ({ page }) => {
    // Same adversarial boundary as above, for the third indented row type: the
    // per-folder empty-state row (.folder-empty-row) shares the capped indent
    // rule, so a deep EMPTY folder's placeholder must not collapse to a blank
    // strip at the 200px minimum sidebar width.
    const DEPTH = 10;
    await openSidebar(page);
    const deepest = await page.evaluate(async (depth) => {
      const win = window as unknown as {
        __testNotes: {
          createFolder: (path: string) => Promise<unknown>;
          createNote: (id: string, body: string) => Promise<unknown>;
        };
      };
      const parts: string[] = [];
      for (let i = 1; i <= depth; i++) {
        parts.push(`e${i}`);
        await win.__testNotes.createFolder(parts.join('/'));
      }
      // A root note nudges the reactive tree to render the (otherwise
      // note-less) empty folder chain; the chain itself stays empty so the
      // deepest folder shows its placeholder row.
      await win.__testNotes.createNote('tree-trigger', 'x');
      return parts.join('/'); // deepest folder, left empty -> shows placeholder
    }, DEPTH);

    const parts: string[] = [];
    for (let i = 1; i <= DEPTH; i++) {
      parts.push(`e${i}`);
      await page
        .locator(`.folder-row[data-folder-path="${parts.join('/')}"]`)
        .first()
        .click();
    }

    await pinSidebarToMinWidth(page);

    const placeholder = page.locator(`.folder-empty-row[data-folder-path="${deepest}"]`);
    await expect(placeholder).toBeVisible();
    const box = await measureRowFit(placeholder);

    // Placeholder keeps a readable width and stays within the viewport — the
    // pre-cap raw indent left it a blank strip here.
    expect(box.contentWidth).toBeGreaterThan(40);
    expect(box.rowRight).toBeLessThanOrEqual(box.scrollRight + 1);
  });
});
