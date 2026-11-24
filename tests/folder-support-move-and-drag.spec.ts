// Part of the folder-support suite: what it covers and why is described in
// folder-support.spec.ts.

import { test, expect } from '@playwright/test';
import { openSidebar } from './lib/folderSupport';

test.describe('Folder support', () => {
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
    await expect(page.locator('.note-row[data-note-id="seed-folder/inside"]')).toBeVisible();

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
});
