import { test, expect, Page } from '@playwright/test';

/**
 * The hover tabs are built inside `toDOM`, where the widget is still detached
 * and every `offsetTop`/`offsetLeft` reads 0 — so they all used to stack at the
 * table's top-left corner instead of sitting beside the row or column they act
 * on. They are positioned when they become visible instead, and repositioned
 * while visible if the table scrolls sideways, because `offsetLeft` is
 * layout-relative and does not move with `scrollLeft`.
 *
 * Assertions are on exact alignment, not on overlap: a tab is 100px wide over an
 * 80px column, so an overlap check still passes with the table scrolled as far
 * as it goes.
 */

const TOLERANCE = 2;

const WIDE_TABLE = [
  'intro paragraph',
  '',
  '| Platform | Status | Owner | Notes | Follow-up | Release |',
  '| --- | --- | --- | --- | --- | --- |',
  '| desktop | ready | ada | none | none | 1.0 |',
  '| android | ready | grace | none | none | 1.0 |',
  '| ios | blocked | alan | signing | keys | 1.1 |',
  '',
  'tail paragraph',
  '',
].join('\n');

async function openTableNote(page: Page): Promise<void> {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/');
  await page.waitForFunction(() => !!(window as { __testNotes?: unknown }).__testNotes, null, {
    timeout: 15000,
  });
  await page.evaluate(async (body) => {
    await (
      window as unknown as { __testNotes: { createNote(t: string, b: string): Promise<void> } }
    ).__testNotes.createNote('Wide table', body);
  }, WIDE_TABLE);
  await page.evaluate(() => {
    window.location.hash = '#/note/Wide%20table';
  });
  await page.waitForSelector('.sf-table', { timeout: 10000 });
  await page.hover('.sf-table');
  await page.waitForSelector('.sf-table--show-controls', { timeout: 5000 });
  await page.waitForTimeout(300);
}

interface TabOffsets {
  rowCount: number;
  columnCount: number;
  rowOffsets: number[];
  visibleColumnOffsets: number[];
}

function readTabOffsets(page: Page): Promise<TabOffsets> {
  return page.evaluate(() => {
    const root = document.querySelector('.sf-table') as HTMLElement;
    const headers = Array.from(root.querySelectorAll<HTMLElement>('thead th'));
    const bodyRows = Array.from(root.querySelectorAll<HTMLElement>('tbody tr'));
    const round = (value: number) => Math.round(value * 10) / 10;

    return {
      rowCount: bodyRows.length,
      columnCount: headers.length,
      rowOffsets: Array.from(root.querySelectorAll<HTMLElement>('.sf-table__row-controls')).map(
        (tab) => {
          const row = bodyRows[Number.parseInt(tab.dataset.row ?? '-1', 10)];
          if (!row) return Number.NaN;
          const tabRect = tab.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          return round(tabRect.top + tabRect.height / 2 - (rowRect.top + rowRect.height / 2));
        },
      ),
      visibleColumnOffsets: Array.from(
        root.querySelectorAll<HTMLElement>('.sf-table__col-controls'),
      )
        .filter((tab) => tab.style.visibility !== 'hidden')
        .map((tab) => {
          const header = headers[Number.parseInt(tab.dataset.col ?? '-1', 10)];
          if (!header) return Number.NaN;
          return round(tab.getBoundingClientRect().left - header.getBoundingClientRect().left);
        }),
    };
  });
}

function expectAllAligned(offsets: number[], what: string): void {
  expect(offsets.length, `${what}: nothing measured, so this proves nothing`).toBeGreaterThan(0);
  for (const offset of offsets) {
    expect(Math.abs(offset), what).toBeLessThan(TOLERANCE);
  }
}

test.describe('table hover controls', () => {
  test('each tab sits against the row or column it acts on', async ({ page }) => {
    await openTableNote(page);
    const { rowCount, columnCount, rowOffsets, visibleColumnOffsets } = await readTabOffsets(page);

    expect(rowCount).toBe(3);
    expect(columnCount).toBe(6);
    expect(rowOffsets.length, 'one tab per body row').toBe(rowCount);
    expectAllAligned(rowOffsets, 'every row tab must be centred on its own row');
    expectAllAligned(
      visibleColumnOffsets,
      "every on-screen column tab must start at its column's left edge",
    );
  });

  test('tabs stay aligned after a row is added while they are showing @webkit-pointer', async ({
    page,
  }) => {
    await openTableNote(page);
    const before = await readTabOffsets(page);
    expectAllAligned(before.rowOffsets, 'row tabs start aligned');

    await page.evaluate(() => {
      const add = document.querySelector(
        '.sf-table__row-controls [aria-label="Add row below"]',
      ) as HTMLElement;
      add.click();
    });
    await page.waitForFunction(
      () => document.querySelectorAll('.sf-table tbody tr').length === 4,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(200);

    const stillShowing = await page.evaluate(() =>
      document.querySelector('.sf-table')!.classList.contains('sf-table--show-controls'),
    );
    expect(stillShowing, 'the tabs are still visible, so no new pointerenter fires').toBe(true);

    const after = await readTabOffsets(page);
    expect(after.rowCount, 'the row landed').toBe(4);
    expect(after.rowOffsets.length, 'one tab per body row').toBe(4);
    expectAllAligned(after.rowOffsets, 'every row tab must still be centred on its own row');
    expectAllAligned(
      after.visibleColumnOffsets,
      'every on-screen column tab must still start at its column edge',
    );
  });

  test('column tabs follow their column when a wide table is scrolled sideways', async ({
    page,
  }) => {
    await openTableNote(page);

    const scrolled = await page.evaluate(() => {
      const scroller = document.querySelector('.sf-table__scroll') as HTMLElement;
      scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
      return scroller.scrollLeft;
    });
    expect(scrolled, 'the table must really scroll for this to mean anything').toBeGreaterThan(20);
    await page.waitForTimeout(300);

    const { visibleColumnOffsets } = await readTabOffsets(page);
    expectAllAligned(visibleColumnOffsets, 'on-screen column tabs must track scrollLeft');
  });
});
