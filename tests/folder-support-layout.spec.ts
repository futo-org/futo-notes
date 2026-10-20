// Part of the folder-support suite: what it covers and why is described in
// folder-support.spec.ts.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { openSidebar } from './lib/folderSupport';

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
  test('note hit zones span the remaining sidebar width at every depth', async ({ page }) => {
    await openSidebar(page);
    await page.evaluate(async () => {
      const win = window as unknown as {
        __testNotes: { createNote: (id: string, body: string) => Promise<unknown> };
      };
      await win.__testNotes.createNote('root-note', 'root');
      await win.__testNotes.createNote('Nested/child-note', 'nested');
    });

    await page.locator('[data-folder-path="Nested"]').first().click();
    await expect(page.locator('[data-note-id="Nested/child-note"]')).toBeVisible();

    const rightEdgeOffsets = await page.evaluate(() => {
      const scroll = document.querySelector('.folder-tree-scroll');
      if (!(scroll instanceof HTMLElement)) throw new Error('Folder tree is missing');

      const contentRight =
        scroll.getBoundingClientRect().right -
        Number.parseFloat(getComputedStyle(scroll).paddingRight);
      return ['root-note', 'Nested/child-note'].map((id) => {
        const row = document.querySelector(`[data-note-id="${id}"]`);
        if (!(row instanceof HTMLElement)) throw new Error(`Note row is missing: ${id}`);
        return contentRight - row.getBoundingClientRect().right;
      });
    });

    expect(rightEdgeOffsets).toEqual([0, 0]);
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

  // Adversarial regression: folder depth is unbounded and the sidebar can
  // shrink to MIN_SIDEBAR_WIDTH (200px). With a raw depth indent, a deep
  // enough row consumes the entire width (depth 10 * 16px = 160px indent vs
  // ~184px content) and renders as a blank, titleless click target. The
  // indent is capped at 50% of the row so every row keeps a usable,
  // title-bearing width at any depth and sidebar width. Both indented row
  // types share the cap: a note row and a deep EMPTY folder's placeholder
  // (.folder-empty-row).
  for (const [rowKind, withLeaf] of [
    ['note row', true],
    ['empty-folder placeholder', false],
  ] as const) {
    test(`a deeply nested ${rowKind} stays usable at the minimum sidebar width`, async ({
      page,
    }) => {
      const DEPTH = 10; // matches "folder depth allowed" + DEPTH_INDENT_PX = 16
      const prefix = withLeaf ? 'd' : 'e';
      await openSidebar(page);
      const deepest = await page.evaluate(
        async ({ depth, prefix, withLeaf }) => {
          const win = window as unknown as {
            __testNotes: {
              createFolder: (path: string) => Promise<unknown>;
              createNote: (id: string, body: string) => Promise<unknown>;
            };
          };
          const parts: string[] = [];
          for (let i = 1; i <= depth; i++) {
            parts.push(`${prefix}${i}`);
            await win.__testNotes.createFolder(parts.join('/'));
          }
          const folder = parts.join('/');
          // Without a leaf, a root note nudges the reactive tree to render the
          // note-less chain, so the deepest folder shows its placeholder row.
          await win.__testNotes.createNote(withLeaf ? `${folder}/leaf` : 'tree-trigger', 'x');
          return folder;
        },
        { depth: DEPTH, prefix, withLeaf },
      );

      // Expand every ancestor folder so the deepest row renders.
      const parts: string[] = [];
      for (let i = 1; i <= DEPTH; i++) {
        parts.push(`${prefix}${i}`);
        await page
          .locator(`.folder-row[data-folder-path="${parts.join('/')}"]`)
          .first()
          .click();
      }

      await pinSidebarToMinWidth(page);

      const row = withLeaf
        ? page.locator(`.note-row[data-note-id="${deepest}/leaf"]`)
        : page.locator(`.folder-empty-row[data-folder-path="${deepest}"]`);
      await expect(row).toBeVisible();
      const box = await measureRowFit(row);

      // The old raw indent left 0px of content here; the row must keep a
      // readable width, and its right edge stays in the viewport.
      expect(box.contentWidth).toBeGreaterThan(40);
      expect(box.rowRight).toBeLessThanOrEqual(box.scrollRight + 1);
    });
  }
});
