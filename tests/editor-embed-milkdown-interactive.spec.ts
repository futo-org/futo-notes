import { expect, test as base, type Page } from '@playwright/test';

import { EDITOR_URL } from './editorEmbedBundle';
import {
  flushFrames,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

/**
 * Interactive-element parity, Milkdown engine — the docs/spec/editor.md
 * "Interactive elements" and "External links" behaviors the T11 line-by-line
 * audit (issue #108) holds against the single-file `editor.html` the native
 * shells ship: list continuation, table editing keys, and the link hit area.
 * Checkbox taps live in `editor-embed-milkdown-parity.spec.ts`; the bridge
 * contract in `editor-embed-milkdown.spec.ts`.
 *
 * Real keyboard/mouse input throughout (AGENTS.md M21).
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
      bridgeVersion: 7,
      theme: 'light',
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  await flushFrames(page);
}

/** Click at the end of the first text run equal to `text`. */
async function caretAtEndOf(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click();
  await page.keyboard.press('End');
}

async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
}

/** The serialized table as trimmed cell texts per row, delimiter row dropped. */
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

// ============================================================
// Lists — continuation (spec: "Pressing Enter in a list item continues the
// list (inherits nesting, auto numbers ordered items)")
// ============================================================

test('Enter continues a bullet list', async ({ page }) => {
  await open(page, '- alpha\n- beta');
  await caretAtEndOf(page, 'beta');
  await page.keyboard.press('Enter');
  await page.keyboard.type('gamma');
  await settled(page);
  expect(await getContent(page)).toContain('- alpha\n- beta\n- gamma');
});

test('Enter continues an ordered list with the next number', async ({ page }) => {
  await open(page, '1. one\n2. two');
  await caretAtEndOf(page, 'two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  await settled(page);
  expect(await getContent(page)).toContain('1. one\n2. two\n3. three');
});

test('Enter in a nested item inherits its nesting', async ({ page }) => {
  await open(page, '- parent\n  - child');
  await caretAtEndOf(page, 'child');
  await page.keyboard.press('Enter');
  await page.keyboard.type('sibling');
  await settled(page);
  expect(await getContent(page)).toContain('- parent\n  - child\n  - sibling');
});

test('Enter on an empty item leaves the list', async ({ page }) => {
  await open(page, '- alpha');
  await caretAtEndOf(page, 'alpha');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('out');
  await settled(page);
  const content = await getContent(page);
  expect(content).toContain('- alpha');
  expect(content).toContain('\nout');
  expect(content).not.toContain('- out');
});

// The CM6 rule this locks: listContinuation.ts always continues a task list
// with `[ ]`, never cloning the current item's checked state.
test('splitting a checked task item starts the new item unchecked', async ({ page }) => {
  await open(page, '- [x] done');
  await caretAtEndOf(page, 'done');
  await page.keyboard.press('Enter');
  await page.keyboard.type('next');
  await settled(page);
  expect(await getContent(page)).toContain('- [x] done\n- [ ] next');
});

test('splitting an unchecked task item stays a task', async ({ page }) => {
  await open(page, '- [ ] todo');
  await caretAtEndOf(page, 'todo');
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await getContent(page)).toContain('- [ ] todo\n- [ ] more');
});

// ============================================================
// Tables — in-place editing keys (spec: "Table cells are individually
// editable in place; Tab/Shift+Tab move between cells; Enter inserts a new
// row below the current one (so on the last row it appends)")
// ============================================================

const TABLE = '| a | b |\n| --- | --- |\n| r1a | r1b |\n| r2a | r2b |';

test('an empty table cell is wide enough to show its caret', async ({ page }) => {
  // A fresh table is all empty cells, and an empty cell collapses to its
  // padding (~34px), which draws the caret against the border and reads as
  // "no caret". The floor is a few characters wide; a filled cell still grows.
  await open(page, '|   |   |\n| - | - |\n|   |   |\n');
  const width = await page
    .locator('.ProseMirror td')
    .first()
    .evaluate((td) => td.getBoundingClientRect().width);
  expect(width).toBeGreaterThanOrEqual(80);
});

test('a table cell is editable in place', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await page.keyboard.type('X');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1aX', 'r1b'],
    ['r2a', 'r2b'],
  ]);
});

test('Tab and Shift+Tab move between cells', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Y'); // goToNextCell selects the cell, typing replaces
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('Z');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['Z', 'Y'],
    ['r2a', 'r2b'],
  ]);
});

test('Enter in a body cell inserts a row below, caret in the same column', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('new');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['', 'new'],
    ['r2a', 'r2b'],
  ]);
});

test('Enter on the last row appends a row', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r2a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('tail');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['r2a', 'r2b'],
    ['tail', ''],
  ]);
});

test('Enter in the header row inserts the first body row', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('top');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['', 'top'],
    ['r1a', 'r1b'],
    ['r2a', 'r2b'],
  ]);
});

test('Enter in a table never drops a stray paragraph after it', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r2b');
  await page.keyboard.press('Enter');
  await settled(page);
  // Two independent sources of a stray `<br />` here once, and this locks both:
  // the gfm preset's bare-Enter `exitTable` binding left an empty paragraph
  // after the table, and the empty cell in the row we now append went through
  // the paragraph serializer's placeholder. The placeholder no longer exists
  // at all (packages/editor/src/milkdown-compat/emptyLine.ts), so this now
  // also guards against it coming back.
  expect(await getContent(page)).not.toContain('<br />');
});

test('Tab at the very last cell appends a row instead of dropping focus', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r2b');
  await page.keyboard.press('Tab');
  await page.keyboard.type('W');
  await settled(page);
  // Before the fix the browser's default Tab moved focus out of the editor
  // and the typed character vanished.
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['r2a', 'r2b'],
    ['W', ''],
  ]);
});

// ============================================================
// External links — hit area (spec: "Only the link's own glyphs open it")
// ============================================================

test('clicking blank space past a link places the caret instead of opening it', async ({
  page,
}) => {
  await open(page, '[site](https://example.com)\n\ntail');
  const link = page.locator('.ProseMirror a').first();
  const box = await link.boundingBox();
  if (!box) throw new Error('no link geometry');
  await page.mouse.click(box.x + box.width + 120, box.y + box.height / 2);
  await flushFrames(page);
  expect(await messagesOfType(page, 'openUrl')).toHaveLength(0);
  await link.click();
  await flushFrames(page);
  expect(await messagesOfType(page, 'openUrl')).toHaveLength(1);
});
