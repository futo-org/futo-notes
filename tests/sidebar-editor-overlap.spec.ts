import { expect, test, type Page } from '@playwright/test';

import { EDITOR, openNewNote } from './lib/desktopEditor';

/**
 * #015 — the desktop selection toolbar (`.futo-selection-toolbar`,
 * `src/features/editor/milkdown/selectionToolbar/`) and the sidebar's
 * create-note/new-folder buttons (`.fab-row`,
 * `src/features/sidebar/components/SidebarCreateActions.svelte`) must never
 * paint over each other.
 *
 * Root cause: the toolbar is a floating-ui tooltip positioned in viewport
 * coordinates (`strategy: 'fixed'`, `root: document.body`) with NO boundary
 * telling its `shift` middleware where the editor's own column ends — its
 * default boundary is the viewport, so it happily slides over the sidebar
 * when a selection sits near the editor's left edge. The fix bounds `shift`
 * to the editable DOM (`selectionToolbar/index.ts`), which starts exactly
 * where the sidebar ends, so the bar can never be placed over the sidebar.
 *
 * This selects text on the LAST VISIBLE LINE of a long note, right against
 * its left margin — the one position that puts both a) the toolbar's natural
 * vertical placement in the same band as the (always bottom-pinned) FAB row,
 * and b) the toolbar's horizontal center close enough to the sidebar that an
 * unbounded floating element spills into it.
 */

function boxesIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Type enough short lines that the note overflows any of the tested viewports. */
async function typeManyLines(page: Page, count: number): Promise<void> {
  await page.locator(EDITOR).click();
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.type(`Line ${i} of overlap repro text.`);
    await page.keyboard.press('Enter');
  }
}

/**
 * Scroll the note's own scroll container until some paragraph's text sits
 * just above the bottom of the viewport, then drag-select its first few
 * characters (a real mouse selection — the toolbar only reacts to ProseMirror's
 * own selection state, not the bare DOM Selection object).
 */
async function selectLineNearBottomLeft(page: Page): Promise<void> {
  const scroller = page.locator('.note-body');
  const found = await scroller.evaluate((el) => {
    const paras = Array.from(el.querySelectorAll('p')).filter((p) => p.textContent?.trim());
    const viewportBottom = el.getBoundingClientRect().bottom;
    for (let scrollTop = 0; scrollTop <= el.scrollHeight; scrollTop += 20) {
      el.scrollTop = scrollTop;
      for (const p of paras) {
        const r = p.getBoundingClientRect();
        if (r.top > viewportBottom - 90 && r.bottom < viewportBottom - 10) {
          return { left: r.left, top: r.top, bottom: r.bottom };
        }
      }
    }
    return null;
  });
  if (!found) throw new Error('Could not scroll a line near the viewport bottom — widen the note.');

  const y = (found.top + found.bottom) / 2;
  await page.mouse.move(found.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(found.left + 40, y, { steps: 4 });
  await page.mouse.up();
}

test.describe('sidebar create-actions vs. editor selection toolbar (#015)', () => {
  for (const viewport of [
    { width: 900, height: 700 },
    { width: 1280, height: 800 },
  ]) {
    test(`never overlap at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openNewNote(page);
      await typeManyLines(page, 30);
      await selectLineNearBottomLeft(page);

      const toolbar = page.locator('.futo-selection-toolbar');
      await expect(toolbar).toBeVisible();

      // `.fab-row` itself is a zero-size flex wrapper (its `.fab` children are
      // individually `position: absolute`, out of its layout flow), so check
      // each create-action button.
      const newNoteBtn = page.locator('.fab[aria-label="New note"]');
      const newFolderBtn = page.locator('.fab[aria-label="New folder"]');
      await expect(newNoteBtn).toBeVisible();
      await expect(newFolderBtn).toBeVisible();

      const toolbarBox = await toolbar.boundingBox();
      const newNoteBox = await newNoteBtn.boundingBox();
      const newFolderBox = await newFolderBtn.boundingBox();
      expect(toolbarBox).not.toBeNull();
      expect(newNoteBox).not.toBeNull();
      expect(newFolderBox).not.toBeNull();
      expect(boxesIntersect(toolbarBox!, newNoteBox!)).toBe(false);
      expect(boxesIntersect(toolbarBox!, newFolderBox!)).toBe(false);

      // And the toolbar never covers editor text either: it must stay at or
      // right of the editor's own left edge.
      const editorBox = await page.locator(EDITOR).boundingBox();
      expect(editorBox).not.toBeNull();
      expect(toolbarBox!.x).toBeGreaterThanOrEqual(editorBox!.x - 1);
    });
  }
});
