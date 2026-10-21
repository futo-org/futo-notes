// Part of the interactive-element parity suite: scope and input rules are in
// editor-embed-milkdown-interactive.spec.ts.

import { expect, type Page } from '@playwright/test';
import { flushFrames, getContent, withCaretObserved } from './lib/editorEmbedHost';
import { test, open, caretAtEndOf, settled, tableRows } from './lib/editorEmbedMilkdownInteractive';

// ============================================================
// Tables — in-place editing keys (spec: "Table cells are individually
// editable in place; Tab/Shift+Tab move between cells; Enter moves the
// caret down to the same column of the row below, only appending a new row
// from the last one")
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

// QA lane 7, 2026-09 (Zvonimir): Enter used to insert a row below EVERY cell,
// no matter which row the caret was in — "I don't like how tables behave...
// Enter will create new row" no matter where you pressed it. It now only
// ever creates a row from the last one; everywhere else it just moves the
// caret down, same column, inserting nothing.
test('Enter in a body cell (not the last row) moves down, inserting no row', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('X');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    // The cell below (r2b) is SELECTED whole, matching Tab's own convention
    // — the same reason "Tab and Shift+Tab move between cells" types with a
    // replacing keystroke rather than an appending one.
    ['r2a', 'X'],
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

test('Enter in the header row moves down into the first body row, inserting nothing', async ({
  page,
}) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('top');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1a', 'top'], // r1b's cell, selected whole and replaced
    ['r2a', 'r2b'],
  ]);
});

// The one remaining way to leave a table from the keyboard — bare Enter no
// longer does (see above). Pinned because it is now SPECIFIED behavior
// rather than an accident of the gfm preset's own keymap: a future preset
// upgrade that dropped or rebound `exitTable` would otherwise silently take
// this away.
test('Mod+Enter exits the table into a new paragraph after it', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r2b');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.type('after the table');
  await settled(page);
  const content = await getContent(page);
  expect(tableRows(content)).toEqual([
    ['a', 'b'],
    ['r1a', 'r1b'],
    ['r2a', 'r2b'],
  ]);
  expect(content.trim().endsWith('after the table')).toBe(true);
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

// A table with no body row: the schema needs one (`table_header_row
// table_row+`), so the editor shows an empty row under the header. That row
// is not the note's — it used to be written as `|  |  |` by the first edit
// anywhere in the table, Mod+Enter out of it included.
const HEADER_ONLY = '| a | b |\n| - | - |\n\nafter\n';

test('an edit to a header-only table writes no body row', async ({ page }) => {
  await open(page, HEADER_ONLY);
  await caretAtEndOf(page, 'b');
  await page.keyboard.type('X');
  await settled(page);
  expect(await getContent(page)).toBe('| a | bX |\n| --- | --- |\n\nafter\n');
});

test('Mod+Enter out of a header-only table writes no body row', async ({ page }) => {
  await open(page, HEADER_ONLY);
  await caretAtEndOf(page, 'b');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.keyboard.type('new line');
  await settled(page);
  expect(await getContent(page)).toBe('| a | b |\n| --- | --- |\n\nnew line\n\nafter\n');
});

test('Enter in a header-only table moves into the empty row, which typing writes', async ({
  page,
}) => {
  await open(page, HEADER_ONLY);
  await caretAtEndOf(page, 'b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('X');
  await settled(page);
  expect(await getContent(page)).toBe('| a | b |\n| --- | --- |\n|  | X |\n\nafter\n');
});

test('a body row the author wrote empty is still written after an edit', async ({ page }) => {
  await open(page, '| a | b |\n| - | - |\n|  |  |\n');
  await caretAtEndOf(page, 'b');
  await page.keyboard.type('X');
  await settled(page);
  expect(await getContent(page)).toBe('| a | bX |\n| --- | --- |\n|  |  |\n');
});

/**
 * A paste carrying an HTML `<table>` (a spreadsheet or web-table copy) while
 * the caret sits in a table cell. Nothing in Playwright or CDP can put HTML on
 * the OS clipboard, so this is a dispatched `ClipboardEvent` with a real
 * `DataTransfer` — it still goes through ProseMirror's own paste handling.
 */
async function pasteHtml(page: Page, html: string, text: string): Promise<void> {
  await page.evaluate(
    ([h, t]) => {
      const transfer = new DataTransfer();
      transfer.setData('text/html', h);
      transfer.setData('text/plain', t);
      document
        .querySelector('.ProseMirror')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
    },
    [html, text],
  );
  await flushFrames(page);
}

test('pasting an HTML table into a table cell throws nothing and pastes the cells', async ({
  page,
}) => {
  // prosemirror-tables' paste path built a row with an extra header cell and
  // died in `TableMap.positionAt` (RC-53): the paste was dropped with a pageerror.
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await pasteHtml(page, '<table><tr><td>X</td><td>Y</td></tr></table>', 'X\tY');
  await settled(page);
  expect(errors).toEqual([]);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['X', 'Y'],
    ['r2a', 'r2b'],
  ]);
});

/*
 * Plain-text pastes into a table cell and a list item (R10-FB13-1/-2, RC-81).
 * `text/html` is left empty, so ProseMirror takes its plain-text route — the one
 * `plainTextBlockPaste.ts` touches — and only the clipboard event is synthetic.
 */
test('multi-line plain text pasted into a cell stays in that cell and spares the next (RC-81)', async ({
  page,
}) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await pasteHtml(page, '', 'P\n\nQ');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1aP Q', 'r1b'],
    ['r2a', 'r2b'],
  ]);
});

/*
 * RC-83: the HTML twin of RC-81. `text/html` with several blocks, caret in a
 * cell: ProseMirror wrapped each `<p>` in a new cell and prosemirror-tables
 * pasted them over the caret's cell and the next (`c1`, `r1b` both lost). A
 * pasted `<table>` is a spreadsheet paste and overwrites by design.
 */
test('several HTML blocks pasted into a cell join in that cell and spare the next (RC-83)', async ({
  page,
}) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await pasteHtml(page, '<p>P <b>bold</b></p><p>Q</p>', 'P bold\n\nQ');
  await settled(page);
  const content = await getContent(page);
  expect(tableRows(content)).toEqual([
    ['a', 'b'],
    ['r1aP **bold** Q', 'r1b'],
    ['r2a', 'r2b'],
  ]);
});

test('an inline run meeting a block keeps its words apart when pasted into a cell (RC-83)', async ({
  page,
}) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await pasteHtml(page, '<span>Kn1 a</span><div>Kn2 b</div>', 'Kn1 a\nKn2 b');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['r1aKn1 a Kn2 b', 'r1b'],
    ['r2a', 'r2b'],
  ]);
});

test('a pasted HTML table still overwrites cell by cell, spreadsheet-style', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await pasteHtml(page, '<table><tr><td>X</td><td>Y</td></tr></table>', 'X\tY');
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['X', 'Y'],
    ['r2a', 'r2b'],
  ]);
});

// A header-only table's empty filler row is not the clipboard's: the editor's
// own copy of one, pasted into a cell, used to blank out the row under the one
// its header lands on.
test('a header-only table copied out of the editor overwrites one row only', async ({ page }) => {
  await open(page, TABLE);
  await caretAtEndOf(page, 'r1a');
  await pasteHtml(
    page,
    '<table><tbody><tr data-is-header="true"><th><p>X</p></th><th><p>Y</p></th></tr>' +
      '<tr data-filler=""><td><p></p></td><td><p></p></td></tr></tbody></table>',
    '| X | Y |\n| --- | --- |',
  );
  await settled(page);
  expect(tableRows(await getContent(page))).toEqual([
    ['a', 'b'],
    ['X', 'Y'],
    ['r2a', 'r2b'],
  ]);
});

test('a lone heading pasted into an empty table cell does not split the table', async ({
  page,
}) => {
  await open(page, '| a | b |\n| --- | --- |\n|   | y |\n');
  await withCaretObserved(page, () => page.locator('.ProseMirror tbody td').first().click());
  await pasteHtml(page, '', '# x');
  await settled(page);
  const content = await getContent(page);
  expect(content.match(/^\|\s*a\s*\|/gm)).toHaveLength(1);
  expect(tableRows(content)).toEqual([
    ['a', 'b'],
    ['x', 'y'],
  ]);
});

test('a list pasted into an empty list item becomes siblings, not a nested list', async ({
  page,
}) => {
  await open(page, '- a\n- b\n');
  await caretAtEndOf(page, 'b');
  await page.keyboard.press('Enter');
  await pasteHtml(page, '', '- x\n- y');
  await settled(page);
  const content = await getContent(page);
  expect(content).not.toMatch(/-\s+-\s/);
  expect(content.match(/^\s*[-*+]\s/gm)).toHaveLength(4);
});

test('a header-only table copied out of the editor pastes back with no body row', async ({
  page,
}) => {
  // The HTML the editor's own copy writes for a header-only table: its filler
  // row is marked in the DOM, so the paste keeps it unwritten.
  await open(page, 'start');
  await caretAtEndOf(page, 'start');
  await page.keyboard.press('Enter');
  await pasteHtml(
    page,
    '<table><tbody><tr data-is-header="true"><th><p>a</p></th><th><p>b</p></th></tr>' +
      '<tr data-filler=""><td><p></p></td><td><p></p></td></tr></tbody></table>',
    '| a | b |\n| --- | --- |',
  );
  await settled(page);
  expect(await getContent(page)).toBe('start\n\n| a | b |\n| --- | --- |\n');
});

test('pasting an HTML table into the header row, and a <th> table into a body row, both land', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, TABLE);
  await caretAtEndOf(page, 'a');
  await pasteHtml(page, '<table><tr><td>X</td><td>Y</td></tr></table>', 'X\tY');
  await settled(page);
  await caretAtEndOf(page, 'r2a');
  await pasteHtml(
    page,
    '<table><tr><th>H1</th><th>H2</th></tr><tr><td>v1</td></tr></table>',
    'H1\tH2\nv1',
  );
  await settled(page);
  expect(errors).toEqual([]);
  // Cells take the type of the row they land in; a ragged pasted row is squared up.
  expect(tableRows(await getContent(page))).toEqual([
    ['X', 'Y'],
    ['r1a', 'r1b'],
    ['H1', 'H2'],
    ['v1', ''],
  ]);
});
