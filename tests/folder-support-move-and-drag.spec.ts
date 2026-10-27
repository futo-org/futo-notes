// Part of the folder-support suite: what it covers and why is described in
// folder-support.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { EDITOR } from './lib/desktopEditor';
import { openSidebar, confirmModal } from './lib/folderSupport';

test.describe('Folder support', () => {
  test('deleting a folder keeps contained notes and moves the open note', async ({ page }) => {
    await openSidebar(page);
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Work/open-note', 'body');
    });

    await page.locator('[data-folder-path="Work"]').first().click();
    await page.locator('.note-row[data-note-id="Work/open-note"]').click();
    await expect(page).toHaveURL(/#\/note\/Work%2Fopen-note/);

    await page.locator('[data-folder-path="Work"]').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await confirmModal(page, 'Delete folder');
    await expect(page.locator('.toast')).toContainText('Folder deleted; moved 1 note');
    await expect(page).toHaveURL(/#\/note\/open-note/);
    await expect(page.locator('.note-row[data-note-id="Work/open-note"]')).toHaveCount(0);
    await expect(page.locator('.note-row[data-note-id="open-note"]')).toBeVisible();
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

  async function seedActionNotes(page: Page): Promise<void> {
    await openSidebar(page);
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('Mover', 'mover body');
      await win.__testNotes.createNote('Bystander', 'bystander body');
      await win.__testNotes.createNote('Work/placeholder', 'placeholder body');
    });
    await page.locator('.note-row[data-note-id="Mover"]').click();
    await page.waitForSelector(EDITOR, { timeout: 10_000 });
  }

  function vaultIds(page: Page): Promise<string[]> {
    return page.evaluate(() =>
      (
        window as unknown as { __testNotes: { getAllNotes: () => Array<{ id: string }> } }
      ).__testNotes
        .getAllNotes()
        .map((note) => note.id)
        .sort(),
    );
  }

  test('moving the open note to a folder ignores a note clicked mid-move', async ({ page }) => {
    await seedActionNotes(page);
    await page.locator('.note-menu-toggle').first().click();
    await page.locator('[data-testid="note-menu-move"]').click();
    await expect(page.locator('.picker-row').filter({ hasText: 'Work' }).first()).toBeVisible();

    // Both clicks in ONE task, so the note click lands inside the move's own
    // await. A real drag or a fast click can hit the same window.
    await page.evaluate(() => {
      const fire = (el: Element) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const work = [...document.querySelectorAll('.picker-row')].find((row) =>
        row.textContent?.includes('Work'),
      )!;
      fire(work);
      fire(document.querySelector('.note-row[data-note-id="Bystander"]')!);
    });

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __testNotes: { getAllNotes: () => Array<{ id: string }> } }
          ).__testNotes
            .getAllNotes()
            .map((note) => note.id)
            .sort(),
        ),
      )
      .toEqual(['Bystander', 'Work/Mover', 'Work/placeholder']);

    await expect(page.locator('.title-input')).toHaveValue('Bystander');
    await expect(page.locator(EDITOR)).toContainText('bystander body');
  });

  test('sidebar move acts on the right-clicked note, not one clicked mid-move', async ({
    page,
  }) => {
    await seedActionNotes(page);
    await page.locator('.note-row[data-note-id="Mover"]').click({ button: 'right' });
    await page.locator('.menu-item').filter({ hasText: 'Move to folder' }).click();
    await expect(page.locator('.picker-row').filter({ hasText: 'Work' }).first()).toBeVisible();

    await page.evaluate(() => {
      const fire = (el: Element) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fire(
        [...document.querySelectorAll('.picker-row')].find((r) => r.textContent?.includes('Work'))!,
      );
      fire(document.querySelector('.note-row[data-note-id="Bystander"]')!);
    });

    await expect
      .poll(() => vaultIds(page))
      .toEqual(['Bystander', 'Work/Mover', 'Work/placeholder']);
  });

  // The right-click both opens the menu and blurs the title, so the id the menu
  // captured dies mid-action. A slow vault settles after the action starts, a fast
  // one before; the delete must land either way.
  for (const [when, settle] of [
    ['the flush finishes after the action starts', async () => {}],
    ['the flush finishes first', async (page: Page) => page.waitForTimeout(600)],
  ] as const) {
    test(`deleting a note whose title was just renamed still deletes it when ${when}`, async ({
      page,
    }) => {
      await seedActionNotes(page);
      await page.locator('.title-input').click();
      await page.locator('.title-input').fill('Mover Renamed');

      await page.locator('.note-row[data-note-id="Mover"]').click({ button: 'right' });
      await settle(page);
      await page.locator('.menu-item').filter({ hasText: 'Delete' }).click();
      await confirmModal(page, 'Delete note');

      await expect.poll(() => vaultIds(page)).toEqual(['Bystander', 'Work/placeholder']);
    });
  }

  test('sidebar delete acts on the right-clicked note, not one clicked mid-delete', async ({
    page,
  }) => {
    await seedActionNotes(page);
    await page.locator('.note-row[data-note-id="Mover"]').click({ button: 'right' });

    await page.evaluate(() => {
      const fire = (el: Element) =>
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fire([...document.querySelectorAll('.menu-item')].find((m) => m.textContent === 'Delete')!);
      fire(document.querySelector('.note-row[data-note-id="Bystander"]')!);
    });
    await confirmModal(page, 'Delete note');

    await expect.poll(() => vaultIds(page)).toEqual(['Bystander', 'Work/placeholder']);
  });
});
