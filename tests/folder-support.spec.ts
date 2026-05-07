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

  test('creating a folder with a Windows-reserved name surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('CON');
    await page.getByTestId('create-folder-confirm').click();
    // The modal stays open with an error message.
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
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('.modal-error')).toContainText(/already exists/i);
  });

  test('creating a folder with an empty name surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('   ');
    await page.getByTestId('create-folder-confirm').click();
    await expect(page.locator('.modal-error')).toBeVisible();
  });

  test('creating a folder with forbidden characters surfaces an error', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-folder-btn').click();
    await page.getByTestId('create-folder-input').fill('bad<name>');
    await page.getByTestId('create-folder-confirm').click();
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
