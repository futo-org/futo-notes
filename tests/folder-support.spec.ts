import { test, expect, Page } from '@playwright/test';

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
    await expect(
      page.locator('[data-folder-path="Specs"]').first(),
    ).toBeVisible();
  });

  test('mobile create-folder modal keeps actions above the input', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.locator('.modal-backdrop').evaluate((el) => el.classList.add('mobile'));

    const actions = page.locator('.modal-actions');
    const input = page.getByTestId('create-folder-input');
    const confirm = page.getByTestId('create-folder-confirm');
    await expect(actions).toBeVisible();
    await expect(confirm).toBeVisible();

    const actionBox = await actions.boundingBox();
    const inputBox = await input.boundingBox();
    const confirmBox = await confirm.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(confirmBox).not.toBeNull();
    expect(actionBox!.y).toBeLessThan(inputBox!.y);
    expect(confirmBox!.y - actionBox!.y).toBeGreaterThanOrEqual(20);
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(90);
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

  test('creating a folder with an empty name keeps Create disabled without an error', async ({ page }) => {
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

    await expect(page.locator('[data-folder-path="Work"] [data-testid="folder-add-subfolder"]')).toHaveCount(0);

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
      const win = window as unknown as { __testNotes: { createNote: (id: string, body: string) => Promise<unknown> } };
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

  test('folder drag-drop falls back to tracked source when MIME data is hidden', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('work');
    await page.getByTestId('create-folder-confirm').click();
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('archive');
    await page.getByTestId('create-folder-confirm').click();

    const moved = await page.evaluate(async () => {
      const archive = document.querySelector('[data-folder-path="archive"]');
      const work = document.querySelector('[data-folder-path="work"]');
      if (!archive || !work) return false;

      archive.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }));
      work.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }));
      work.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }));
      archive.dispatchEvent(new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }));
      await new Promise(r => setTimeout(r, 50));
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
      const win = window as unknown as { __testNotes: { createNote: (id: string, body: string) => Promise<unknown> } };
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
      const nested = noteRows.find(r => r.getAttribute('data-note-id') === 'seed-folder/inside');
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
      nested.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 30));

      const topRows = noteRows.filter(r => {
        const id = r.getAttribute('data-note-id') ?? '';
        return id.startsWith('top-');
      });
      // Sweep: dragover row N, then dragleave row N with relatedTarget=null
      // (the WebKitGTK pattern), repeat for each row.
      for (const row of topRows) {
        row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await new Promise(r => requestAnimationFrame(r));
        row.dispatchEvent(new DragEvent('dragleave', {
          bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget: null,
        }));
        await new Promise(r => requestAnimationFrame(r));
      }
      obs.disconnect();
      nested.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { flips, transitionCount: flips.length - 1 };
    });

    if ('error' in transitions) throw new Error(`Setup failed: ${transitions.error}`);
    // The outline should turn on once when the cursor enters the root
    // area and stay on. One transition (off → on). More than 2 means
    // the outline is oscillating — the regression we're guarding against.
    expect(transitions.transitionCount).toBeLessThanOrEqual(2);
  });
});
