import { expect, test as base, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from './editorEmbedBundle';
import {
  flushFrames,
  getContent,
  installFakeAndroidHost,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

/**
 * Table row/column grips (QA lane 7 — Zvonimir: "no way to add new columns,
 * no way to delete rows or columns"; docs/spec/editor.md "Tables"), driven
 * against the real single-file `editor.html` bundle the native shells ship.
 *
 * Real mouse input throughout (AGENTS.md M21): hover to reveal a grip, click
 * it, click a menu entry.
 */

/** @milkdown/plugin-listener debounces `markdownUpdated` by 200 ms (trailing). */
const CHANGE_DEBOUNCE_MS = 200;

const test = base.extend<{ page: Page }>({
  page: async ({ browser }, use) => {
    const context = await browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as FakeHostWindow).__msgs?.some((m) => m.type === 'ready'),
    );
    await use(page);
    await context.close();
  },
});

async function open(page: Page, content: string): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    JSON.stringify({
      bridgeVersion: BRIDGE_VERSION,
      theme: 'light',
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  await flushFrames(page);
}

async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
}

/** The serialized table as trimmed cell texts per row, delimiter row dropped —
 * same shape `editor-embed-milkdown-interactive.spec.ts` uses. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
}

/** Hover the cell containing `text`, revealing its row+column grips. */
async function hoverCell(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().hover();
}

async function clickMenuItem(page: Page, label: string): Promise<void> {
  await page.locator('.futo-table-grip-menu-item', { hasText: label }).first().click();
}

const TABLE = '| a | b |\n| --- | --- |\n| r1a | r1b |\n| r2a | r2b |';

test('a column grip inserts a column to its right', async ({ page }) => {
  await open(page, TABLE);
  await hoverCell(page, 'a');
  await page.locator('.futo-table-grip-col').click();
  await clickMenuItem(page, 'Insert after');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', '', 'b'],
    ['r1a', '', 'r1b'],
    ['r2a', '', 'r2b'],
  ]);
});

test('a column grip inserts a column to its left', async ({ page }) => {
  await open(page, TABLE);
  await hoverCell(page, 'b');
  await page.locator('.futo-table-grip-col').click();
  await clickMenuItem(page, 'Insert before');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', '', 'b'],
    ['r1a', '', 'r1b'],
    ['r2a', '', 'r2b'],
  ]);
});

test('a row grip inserts a row below it', async ({ page }) => {
  await open(page, TABLE);
  await hoverCell(page, 'r1a');
  await page.locator('.futo-table-grip-row').click();
  await clickMenuItem(page, 'Insert after');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['', ''],
    ['r2a', 'r2b'],
  ]);
});

test('a row grip inserts a row above it', async ({ page }) => {
  await open(page, TABLE);
  await hoverCell(page, 'r2a');
  await page.locator('.futo-table-grip-row').click();
  await clickMenuItem(page, 'Insert before');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['', ''],
    ['r2a', 'r2b'],
  ]);
});

test('a row grip deletes its row', async ({ page }) => {
  await open(page, TABLE);
  await hoverCell(page, 'r1a');
  await page.locator('.futo-table-grip-row').click();
  await clickMenuItem(page, 'Delete');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r2a', 'r2b'],
  ]);
});

test('a column grip deletes its column', async ({ page }) => {
  await open(page, TABLE);
  await hoverCell(page, 'a');
  await page.locator('.futo-table-grip-col').click();
  await clickMenuItem(page, 'Delete');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([['b'], ['r1b'], ['r2b']]);
});

test('the header row grip cannot delete the header and cannot insert before it', async ({
  page,
}) => {
  await open(page, TABLE);
  await hoverCell(page, 'a');
  await page.locator('.futo-table-grip-row').click();
  const before = page.locator('.futo-table-grip-menu-item', { hasText: 'Insert before' });
  const del = page.locator('.futo-table-grip-menu-item', { hasText: 'Delete' });
  await expect(before).toBeDisabled();
  await expect(del).toBeDisabled();
  // A disabled entry must say why, not just look greyed out.
  await expect(del).toHaveAttribute('title', /header row/i);
  // Clicking a disabled button is a no-op; the table survives untouched.
  await del.click({ force: true });
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['r2a', 'r2b'],
  ]);
});

// docs/spec/editor.md "Markdown toolbar": the mobile shells' keyboard dismiss
// (the bridge blur) ends the editing session. A tap shows the grips through the
// emulated mouse events and never sends the `mouseleave` that hides them, so
// they stayed on screen after the keyboard went away.
test.describe('the bridge blur ends the table editing session', () => {
  const visibleGrips = (page: Page) => page.locator('.futo-table-grip:not([hidden])');

  async function blur(page: Page): Promise<void> {
    await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.blur());
    await flushFrames(page);
  }

  test('hides the grips a touch left showing', async ({ page }) => {
    await open(page, TABLE);
    await page.getByText('r1a', { exact: true }).click();
    await expect(visibleGrips(page)).toHaveCount(2);

    await blur(page);
    await expect(visibleGrips(page)).toHaveCount(0);

    // Touching the table again brings them straight back.
    await hoverCell(page, 'r2b');
    await expect(visibleGrips(page)).toHaveCount(2);
  });

  test('clears a cell selection', async ({ page }) => {
    await open(page, TABLE);
    const from = await page.getByText('r1a', { exact: true }).boundingBox();
    const to = await page.getByText('r2b', { exact: true }).boundingBox();
    await page.mouse.move(from!.x + 4, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(to!.x + 4, to!.y + to!.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator('.selectedCell')).toHaveCount(4);

    await blur(page);
    await expect(page.locator('.selectedCell')).toHaveCount(0);
    expect(await page.evaluate(() => document.getSelection()?.rangeCount)).toBe(0);
  });
});

test('deleting a table down to its last row/column disables further deletes', async ({ page }) => {
  await open(page, '| only |\n| --- |\n| r1 |\n');
  await hoverCell(page, 'r1');
  await page.locator('.futo-table-grip-row').click();
  const rowDelete = page.locator('.futo-table-grip-menu-item', { hasText: 'Delete' });
  await expect(rowDelete).toBeDisabled();
  await expect(rowDelete).toHaveAttribute('title', /at least one row/i);
});
