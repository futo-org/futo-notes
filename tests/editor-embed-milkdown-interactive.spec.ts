import { expect, test as base, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from './editorEmbedBundle';
import {
  flushFrames,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
  waitForMessages,
  withCaretObserved,
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
      bridgeVersion: BRIDGE_VERSION,
      noteId: 'test-note',
      theme: 'light',
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  await flushFrames(page);
}

/**
 * Click at the end of the first text run equal to `text`.
 *
 * The click goes through `withCaretObserved` because ProseMirror learns about
 * a pointer-placed caret from an ASYNC `selectionchange`, one rendering update
 * later — while Playwright's next call lands ~3 ms later. Without the wait the
 * Enter/Tab that follows is handled against the caret from BEFORE the click
 * (its doc comment has the whole story). `End` is deliberately outside the
 * wait: it can legitimately be a no-op, and it never leaves the cell the
 * table commands resolve.
 */
async function caretAtEndOf(page: Page, text: string): Promise<void> {
  await withCaretObserved(page, () => page.getByText(text, { exact: true }).first().click());
  await page.keyboard.press('End');
}

async function settled(page: Page): Promise<void> {
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
}

/**
 * Click at the left edge of the first text run equal to `text` (see
 * `caretAtEndOf`). This places the caret at offset zero directly. Sending Home
 * afterward is a no-op on some hosts and produces no `selectionchange`, which
 * made the caret observer wait until timeout despite a correct selection.
 */
async function caretAtStartOf(page: Page, text: string): Promise<void> {
  await withCaretObserved(page, () =>
    page
      .getByText(text, { exact: true })
      .first()
      .click({ position: { x: 0, y: 0 } }),
  );
  await page.waitForFunction((expectedText) => {
    const selection = document.getSelection();
    return (
      selection?.isCollapsed === true &&
      selection.anchorNode?.textContent === expectedText &&
      selection.anchorOffset === 0
    );
  }, text);
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

test('two immediate modifier clicks open two different links', async ({ page }) => {
  await open(page, '[first](https://example.com/one)\n\n[second](https://example.com/two)');
  await page
    .locator('.ProseMirror a')
    .nth(0)
    .click({ modifiers: ['Meta'] });
  await page
    .locator('.ProseMirror a')
    .nth(1)
    .click({ modifiers: ['Meta'] });
  expect((await messagesOfType(page, 'openUrl')).map((message) => message.url)).toEqual([
    'https://example.com/one',
    'https://example.com/two',
  ]);
});

test('scrolling from an external link does not open it', async ({ page }) => {
  await open(
    page,
    'before\n\nbefore again\n\n[site](https://example.com)\n\n' +
      Array.from({ length: 100 }, (_, i) => `paragraph ${i}`).join('\n\n'),
  );
  const box = await page.locator('.ProseMirror a').first().boundingBox();
  if (!box) throw new Error('link has no geometry');
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y: y - step * 8 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(() => page.locator('.ProseMirror').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  expect(await messagesOfType(page, 'openUrl')).toHaveLength(0);
});

test('holding a link through the block long press does not open it', async ({ page }) => {
  await open(page, '[site](https://example.com)\n\nnext');
  const box = await page.locator('.ProseMirror a').first().boundingBox();
  if (!box) throw new Error('link has no geometry');
  const cdp = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  const [drag] = await waitForMessages(page, 'blockDrag');
  expect(drag.active).toBe(true);
  await expect(page.locator('.futo-mobile-dnd-ghost')).toBeVisible();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await flushFrames(page);
  expect(await messagesOfType(page, 'openUrl')).toHaveLength(0);
});

test('releasing a link while another finger remains down does not open it', async ({ page }) => {
  await open(page, '[site](https://example.com)\n\nnext');
  const box = await page.locator('.ProseMirror a').first().boundingBox();
  if (!box) throw new Error('link has no geometry');
  // The second finger starts outside the editor, so its touchstart cannot
  // reset the editor's tracked first touch by bubbling through the container.
  const other = await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0 0 auto auto;width:80px;height:80px;z-index:99999';
    document.body.appendChild(overlay);
    document.addEventListener(
      'touchend',
      (event) => {
        if (Array.from(event.changedTouches).some((touch) => touch.identifier === 1)) {
          (window as unknown as { __remainingTouches?: number }).__remainingTouches =
            event.touches.length;
        }
      },
      true,
    );
    return { x: innerWidth - 30, y: 30 };
  });
  const cdp = await page.context().newCDPSession(page);
  const first = { id: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const second = { id: 2, ...other };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first, second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [second] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await flushFrames(page);
  expect(
    await page.evaluate(
      () => (window as unknown as { __remainingTouches?: number }).__remainingTouches,
    ),
  ).toBe(1);
  expect(await messagesOfType(page, 'openUrl')).toHaveLength(0);
});

// ============================================================
// Lists — Backspace at a nested item's own start keeps the indentation
// (QA #004; docs/spec/editor.md "Markdown toolbar" family / keyboardParity.ts)
//
// These pin EXISTING behavior — `@milkdown/preset-commonmark`'s own
// `liftFirstListItemCommand` (Backspace -> `joinBackward`) already does this
// correctly, because `list_item` is `defining: true` in the schema, so no new
// code was needed in keyboardParity.ts. Kept here as a regression guard: a
// future preset upgrade that changed this default would be exactly the kind
// of silent behavior drift these specs exist to catch.
// ============================================================

test('Backspace at the start of a nested item keeps its indentation', async ({ page }) => {
  await open(page, '- a\n  - b');
  await caretAtStartOf(page, 'b');
  await page.keyboard.press('Backspace');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('- a\n\n  b');
});

test('a second Backspace on that continuation paragraph joins it with the previous block', async ({
  page,
}) => {
  await open(page, '- a\n  - b');
  await caretAtStartOf(page, 'b');
  await page.keyboard.press('Backspace');
  await settled(page);
  await page.keyboard.press('Backspace');
  await settled(page);
  // "b" is no longer its own continuation paragraph — it joined whatever
  // precedes it in item "a" (the ordinary Backspace-join `joinBackward`
  // already gives anywhere else), and there is only one list item left.
  expect((await getContent(page)).trimEnd()).toBe('- ab');
});

test('Backspace at the start of a TOP-LEVEL item is unaffected (removes the marker only)', async ({
  page,
}) => {
  await open(page, '- a\n- b');
  await caretAtStartOf(page, 'b');
  await page.keyboard.press('Backspace');
  await settled(page);
  const content = (await getContent(page)).trimEnd();
  // Still one list item ("a"), and "b" is no longer a bullet of its own.
  expect(content).not.toMatch(/^- b/m);
  expect(content).toContain('a');
  expect(content).toContain('b');
});

test('Backspace on a nested item with a following sibling leaves the sibling nested', async ({
  page,
}) => {
  await open(page, '- a\n  - b\n  - c');
  await caretAtStartOf(page, 'b');
  await page.keyboard.press('Backspace');
  await settled(page);
  const content = (await getContent(page)).trimEnd();
  // Two paragraphs in a row make the item loose, so its every block is spaced
  // (docs/spec/editor.md "Markdown house style").
  expect(content).toBe('- a\n\n  b\n\n  - c');
});

test('Backspace on a nested item with a PRECEDING sibling joins the sibling instead of "a"', async ({
  page,
}) => {
  // "b" joins "x" (whatever immediately precedes it), not "a" two levels up —
  // the ordinary Backspace-join semantic, same as everywhere else in the doc.
  await open(page, '- a\n  - x\n  - b');
  await caretAtStartOf(page, 'b');
  await page.keyboard.press('Backspace');
  await settled(page);
  const content = (await getContent(page)).trimEnd();
  expect(content).toBe('- a\n  - x\n\n    b');
});

// ============================================================
// Code blocks — Tab indentation (QA #011; keyboardParity.ts)
// ============================================================

test('Tab inside a code block inserts two spaces instead of moving focus out', async ({ page }) => {
  await open(page, '```\nconst x = 1;\n```');
  await caretAtStartOf(page, 'const x = 1;');
  await page.keyboard.press('Tab');
  await settled(page);
  expect(await getContent(page)).toContain('```\n  const x = 1;\n```');
});

test('Shift+Tab inside a code block removes up to two leading spaces', async ({ page }) => {
  await open(page, '```\n  const x = 1;\n```');
  await caretAtStartOf(page, '  const x = 1;');
  await page.keyboard.press('Shift+Tab');
  await settled(page);
  expect(await getContent(page)).toContain('```\nconst x = 1;\n```');
});

test('Tab over a multi-line selection in a code block indents every touched line', async ({
  page,
}) => {
  await open(page, '```\none\ntwo\nthree\n```');
  // `caretAtStartOf` matches a text node EXACTLY, which a multi-line code
  // block's single text node ("one\ntwo\nthree") never does. Place the caret
  // at that node's start. Select the intended lines directly because browser
  // vertical movement through a code block depends on font and line layout.
  await withCaretObserved(page, () =>
    page
      .locator('.ProseMirror pre')
      .first()
      .evaluate((pre) => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error('code block has no text node');
        document.getSelection()?.collapse(text, 0);
      }),
  );
  await withCaretObserved(page, () =>
    page
      .locator('.ProseMirror pre')
      .first()
      .evaluate((pre) => {
        const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error('code block text node is missing');
        document.getSelection()?.setBaseAndExtent(text, 0, text, 'one\ntwo'.length);
      }),
  );
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('one\ntwo');
  await page.keyboard.press('Tab');
  await settled(page);
  expect(await getContent(page)).toContain('```\n  one\n  two\nthree\n```');
});

test('Escape then Tab releases the code-block claim for the next Tab only', async ({ page }) => {
  await open(page, '```\ncode\n```');
  await caretAtStartOf(page, 'code');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  // The released Tab moved focus off the editor onto the block's own chrome
  // (the ⋮ menu) rather than the fence — the editor no longer has the caret,
  // so nothing typed next reaches the code block.
  await expect(page.locator('.ProseMirror')).not.toBeFocused();
  await page.locator('.ProseMirror').click();
  await caretAtStartOf(page, 'code');
  await page.keyboard.type('x'); // re-arms the claim
  await withCaretObserved(page, () => page.keyboard.press('ArrowLeft'));
  await page.keyboard.press('Tab');
  await settled(page);
  expect(await getContent(page)).toContain('  xcode');
});

// ============================================================
// Typed text saves with the escapes it needs (hardening L6e-1/13/14). Each
// case types, saves, re-opens what was saved, and checks the note still MEANS
// what was typed — the serializer's escaping is only visible on the reopen.
// ============================================================

/** Open `markdown` as a different note, the way the host re-opens a saved one. */
async function reopen(page: Page, markdown: string): Promise<void> {
  // Through another note first, so a same-bytes reopen is never deduped away.
  await page.evaluate(() =>
    (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', '-'),
  );
  await page.evaluate(
    (m) => (window as unknown as FakeHostWindow).FutoEditor.setContent('test-note', m),
    markdown,
  );
  await flushFrames(page);
}

/** The cell texts of table row `index` (0 = header) in the rendered document. */
function renderedRow(page: Page, index: number): Promise<string[]> {
  return page.locator('.ProseMirror tr').nth(index).locator('td, th').allTextContents();
}

const SMALL_TABLE = '| a | b |\n| - | - |\n| c | d |\n';

test('a pipe typed in a table cell before bold stays in its cell', async ({ page }) => {
  // Milkdown writes a text run that ends in whitespace raw, so the run before
  // a mark lost its `\|` and the next open split the row.
  await open(page, SMALL_TABLE);
  await caretAtEndOf(page, 'c');
  await page.keyboard.type(' x | y ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await renderedRow(page, 1), saved).toEqual(['c x | y bold', 'd']);
});

test('a pipe typed in a table cell survives a pause after a trailing space', async ({ page }) => {
  // No mark at all: the cell's last run ends in a space, which is what the
  // autosave sees whenever the user pauses after one.
  await open(page, SMALL_TABLE);
  await caretAtEndOf(page, 'c');
  await page.keyboard.type(' x | y ');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(
    (await renderedRow(page, 1)).map((cell) => cell.trim()),
    saved,
  ).toEqual(['c x | y', 'd']);
});

test('a line of a paragraph that starts with an escaped "# " stays in the paragraph', async ({
  page,
}) => {
  // Typing `# ` at the start of a line makes a heading (the line-start
  // shortcut), so the line comes from the file, escaped as text.
  await openAtEnd(page, 'Notes\n\\# not a heading');
  await page.keyboard.type(' ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror h1').count(), saved).toBe(0);
  expect(await paragraphLines(page), saved).toEqual(['Notes\n# not a heading bold']);
});

test('"&amp;" typed before bold is still "&amp;" after a reopen', async ({ page }) => {
  await open(page, 'Notes');
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.type(' write &amp; for & ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror p').first().textContent(), saved).toBe(
    'Notes write &amp; for & bold',
  );
});

test('Shift+Enter at the end of a heading starts a paragraph, as Enter does', async ({ page }) => {
  // It used to insert a hard break in the heading, written `\` + newline,
  // which ended the heading and left a stray backslash.
  await open(page, '#### Plan');
  await caretAtEndOf(page, 'Plan');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('next');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).toBe('#### Plan\n\nnext\n');
});

// remark-stringify would not end a line in front of an inline HTML node (it
// could open an HTML block, syntax-tree/mdast-util-to-markdown#15) and wrote a
// space instead, so the newline was lost. `<kbd>` cannot open a block that
// interrupts a paragraph, and the editor's own serializer (#266) writes the
// newline. The space before it is not written: whitespace at a line's end
// never is.
test('Enter directly before inline HTML keeps the newline and adds no backslash', async ({
  page,
}) => {
  await open(page, 'Press <kbd>Ctrl</kbd> now');
  // Only the caret is placed through the DOM (directly before the `<kbd>`
  // atom, which no click can target); the break itself is a real Shift+Enter.
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror p')?.firstChild;
      if (!text) throw new Error('no text node');
      const range = document.createRange();
      range.setStart(text, 'Press '.length);
      range.collapse(true);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }),
  );
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await getContent(page)).toBe('Press\n<kbd>Ctrl</kbd> now\n');
});

/** Select the first `length` characters of the first paragraph, as a mouse drag would. */
async function selectParagraphStart(page: Page, length: number): Promise<void> {
  await page.locator('.ProseMirror p').first().click();
  await withCaretObserved(page, () =>
    page.evaluate((selected) => {
      const text = document.querySelector('.ProseMirror p')?.firstChild;
      if (!text) throw new Error('no text node');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, selected);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }, length),
  );
}

for (const [name, text, length, key, tag] of [
  ['Mod+B on "Note:" before a letter', 'Note:bar', 5, 'b', 'strong'],
  ['Mod+I on "Note:" before a letter', 'Note:bar', 5, 'i', 'em'],
  ['Mod+Alt+X on "Note:" before a letter', 'Note:bar', 5, 'Alt+x', 'del'],
  // CJK: bold on a phrase ending in a full-width colon, before the next ideograph.
  ['Mod+B on a CJK phrase ending in a full-width colon', '重要：这是', 3, 'b', 'strong'],
] as const) {
  test(`${name} is still formatted after a reopen`, async ({ page }) => {
    await open(page, text);
    await selectParagraphStart(page, length);
    await page.keyboard.press(`ControlOrMeta+${key}`);
    await settled(page);
    const saved = await getContent(page);
    await reopen(page, saved);
    expect(await page.locator(`.ProseMirror p ${tag}`).allTextContents(), saved).toEqual([
      text.slice(0, length),
    ]);
  });
}

test('a letter typed before an underscore emphasis followed by a `*` run keeps both italic', async ({
  page,
}) => {
  // FB-4a round 2: the dropped `_` to `*` re-spelling saved `a Z*b**c*`, which
  // reopens with two literal `**` in the text.
  await open(page, 'a _b_*c*');
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror p')?.firstChild;
      if (!text) throw new Error('no text node');
      const range = document.createRange();
      range.setStart(text, 'a '.length);
      range.collapse(true);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }),
  );
  await page.keyboard.type('Z');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).not.toContain('**');
  await reopen(page, saved);
  // Both letters stay italic. The two touching runs, `_` then `*`, are written
  // as one (docs/spec/editor.md "Markdown house style").
  expect(await page.locator('.ProseMirror p em').allTextContents(), saved).toEqual(['bc']);
});

// ============================================================
// Typed `![alt](src)` becomes an image as the closing `)` is typed (RC-56,
// docs/spec/editor.md "Formatting is reachable by typing Markdown"). The
// vault filename, an external https/http URL, a URL with a query string, the
// `<…>` form and a title all convert, render, and save back as the same bytes.
// ============================================================

const IMAGE_BASE = 'file:///vault/';

/** Rendered images — ProseMirror adds its own `img.ProseMirror-separator` after a trailing inline atom. */
const IMAGES = '.ProseMirror img:not(.ProseMirror-separator)';

/** Type `typed` on a new line after "Notes" in a note whose host registered a base URL. */
async function typeAfterNotes(page: Page, typed: string): Promise<void> {
  await open(page, 'Notes');
  await page.evaluate(
    (base) => (window as unknown as FakeHostWindow).FutoEditor.setImageBaseUrl(base),
    IMAGE_BASE,
  );
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.press('Enter');
  await page.keyboard.type(typed);
  await settled(page);
}

for (const [name, typed, src, alt, title, rendered] of [
  [
    'a vault filename',
    '![alt](image-123.png)',
    'image-123.png',
    'alt',
    null,
    IMAGE_BASE + 'image-123.png',
  ],
  [
    'an empty alt and a vault filename',
    '![](image-123.png)',
    'image-123.png',
    '',
    null,
    IMAGE_BASE + 'image-123.png',
  ],
  [
    'an external https URL',
    '![alt](https://example.com/a.png)',
    'https://example.com/a.png',
    'alt',
    null,
    'https://example.com/a.png',
  ],
  [
    'an external http URL with an empty alt',
    '![](http://example.com/b.png)',
    'http://example.com/b.png',
    '',
    null,
    'http://example.com/b.png',
  ],
  [
    'an external URL with a query string',
    '![alt](https://example.com/a.png?w=100)',
    'https://example.com/a.png?w=100',
    'alt',
    null,
    'https://example.com/a.png?w=100',
  ],
  [
    'a `<…>` destination with a space',
    '![alt](<my photo.png>)',
    'my photo.png',
    'alt',
    null,
    IMAGE_BASE + 'my%20photo.png',
  ],
  [
    'a title',
    '![alt](https://example.com/a.png "the title")',
    'https://example.com/a.png',
    'alt',
    'the title',
    'https://example.com/a.png',
  ],
] as const) {
  test(`typing ${name} as ![alt](…) becomes a rendered image that saves as typed`, async ({
    page,
  }) => {
    await typeAfterNotes(page, typed);
    const image = page.locator(`.ProseMirror img[data-futo-src="${src}"]`);
    await expect(image).toHaveCount(1);
    await expect(image).toHaveAttribute('src', rendered);
    await expect(image).toHaveAttribute('alt', alt);
    if (title) await expect(image).toHaveAttribute('title', title);
    const saved = await getContent(page);
    expect(saved).toBe(`Notes\n${typed}\n`);
    // And the saved bytes reopen as the same image.
    await reopen(page, saved);
    await expect(page.locator(`.ProseMirror img[data-futo-src="${src}"]`)).toHaveCount(1);
    expect(await getContent(page)).toBe(saved);
  });
}

test('a typed external URL keeping its `&` reopens as the same image', async ({ page }) => {
  // The serializer writes `&` in a destination as `\&` (an entity guard — the
  // same for a link, and for any note opened and edited); it means the same
  // URL, so what must hold is that the image still points at it after a save.
  const url = 'https://example.com/a.png?w=100&h=50';
  await typeAfterNotes(page, `![alt](${url})`);
  await expect(page.locator(`.ProseMirror img[data-futo-src="${url}"]`)).toHaveCount(1);
  await reopen(page, await getContent(page));
  await expect(page.locator(`.ProseMirror img[data-futo-src="${url}"]`)).toHaveCount(1);
});

test('a typed image converts in the middle of a sentence and keeps the text around it', async ({
  page,
}) => {
  await typeAfterNotes(page, 'see ![alt](https://example.com/a.png) here');
  await expect(page.locator(IMAGES)).toHaveCount(1);
  expect(await getContent(page)).toBe('Notes\nsee ![alt](https://example.com/a.png) here\n');
});

test('one Ctrl+Z after the typed image converts undoes it, like another rule does', async ({
  page,
}) => {
  // The rule replaces the run without ever inserting the `)` that triggered it,
  // so undoing it gives back the text as it stood before that keystroke — the
  // same as `**bold**`. The pause keeps the conversion out of the typing's own
  // undo group (prosemirror-history merges edits closer than 500 ms).
  await open(page, 'Notes');
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.press('Enter');
  await page.keyboard.type('![alt](https://example.com/a.png');
  await page.waitForTimeout(700);
  await page.keyboard.type(')');
  await expect(page.locator(IMAGES)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await lastLine(page)).toBe('![alt](https://example.com/a.png');

  // Control: the strong rule, same shape.
  await page.keyboard.press('Enter');
  await page.keyboard.type('**bold*');
  await page.waitForTimeout(700);
  await page.keyboard.type('*');
  await expect(page.locator('.ProseMirror p strong')).toHaveText('bold');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.ProseMirror p strong')).toHaveCount(0);
  expect(await lastLine(page)).toBe('**bold*');
});

test('a typed image does not convert inside inline code', async ({ page }) => {
  await typeAfterNotes(page, '`![alt](https://example.com/a.png)`');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  await expect(page.locator('.ProseMirror p code').last()).toHaveText(
    '![alt](https://example.com/a.png)',
  );
  expect(await getContent(page)).toBe('Notes\n`![alt](https://example.com/a.png)`\n');
});

test('a typed image does not convert inside an existing code span', async ({ page }) => {
  await open(page, '`ab`');
  // Only the caret is placed through the DOM (between the `a` and the `b`);
  // the typing itself is real.
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror p code')?.firstChild;
      if (!text) throw new Error('no code text node');
      const range = document.createRange();
      range.setStart(text, 1);
      range.collapse(true);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }),
  );
  await page.keyboard.type('![x](https://example.com/a.png)');
  await settled(page);
  await expect(page.locator(IMAGES)).toHaveCount(0);
  await expect(page.locator('.ProseMirror p code')).toHaveText('a![x](https://example.com/a.png)b');
});

test('a typed image does not convert inside a code block', async ({ page }) => {
  await open(page, '```\n\n```\n');
  await page.locator('.ProseMirror pre').click();
  await page.keyboard.type('![alt](https://example.com/a.png)');
  await settled(page);
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await getContent(page)).toContain('![alt](https://example.com/a.png)');
  expect(await getContent(page)).toMatch(/^```\n!\[alt\]\(https:\/\/example.com\/a.png\)\n```/);
});

test('an escaped `\\![alt](…)` typed in a paragraph stays text', async ({ page }) => {
  await typeAfterNotes(page, '\\![alt](https://example.com/a.png)');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  const saved = await getContent(page);
  await reopen(page, saved);
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await lastLine(page), saved).toBe('\\![alt](https://example.com/a.png)');
});

test('a typed plain link `[a](b)` is not turned into an image or a link', async ({ page }) => {
  await typeAfterNotes(page, '[a](https://example.com)');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await lastLine(page)).toBe('[a](https://example.com)');
});

// ============================================================
// A nested list made by typing saves TIGHT (RC-102). Items the editor creates
// used to carry `spread: true`, so the moment Tab gave one a child list the item
// text and the list were separated by a blank line — where the same list opened
// from a tight file and edited stayed tight. Two spellings of one list, and the
// loose one reads as a different document to any other Markdown renderer.
// ============================================================

/** Presses `Enter` / `Tab` for those exact entries and types everything else. */
async function typeAndPress(page: Page, steps: string[]): Promise<void> {
  for (const step of steps) {
    if (step === 'Enter' || step === 'Tab') await page.keyboard.press(step);
    else await page.keyboard.type(step);
  }
}

test('a bullet list nested by typing Enter then Tab saves tight', async ({ page }) => {
  await open(page, '');
  await page.locator('.ProseMirror').click();
  await typeAndPress(page, ['- item a', 'Enter', 'item b', 'Enter', 'Tab', 'nested c']);
  await settled(page);
  expect(await getContent(page)).toBe('- item a\n- item b\n  - nested c\n');
});

test('an ordered list nested by typing Enter then Tab saves tight', async ({ page }) => {
  await open(page, '');
  await page.locator('.ProseMirror').click();
  await typeAndPress(page, ['1. one', 'Enter', 'two', 'Enter', 'Tab', 'nested']);
  await settled(page);
  expect(await getContent(page)).toBe('1. one\n2. two\n   1. nested\n');
});

test('the same list opened from a tight file and edited saves the same bytes', async ({ page }) => {
  await open(page, '- item a\n- item b\n  - nested c\n');
  await caretAtEndOf(page, 'nested c');
  await page.keyboard.type('!');
  await settled(page);
  expect(await getContent(page)).toBe('- item a\n- item b\n  - nested c!\n');
});

test('a LOOSE file keeps its blank lines after the same edit', async ({ page }) => {
  await open(page, '- item a\n\n- item b\n\n  - nested c\n');
  await caretAtEndOf(page, 'nested c');
  await page.keyboard.type('!');
  await settled(page);
  expect(await getContent(page)).toBe('- item a\n\n- item b\n\n  - nested c!\n');
});

// ============================================================
// Paragraphs and lines — Enter is a newline (docs/spec/editor.md "Paragraphs
// and lines", #263). Each case asserts only two things: the bytes the editor
// would save, and what the reader sees.
// ============================================================

/** The visible text of the editor's top-level paragraphs, a `<br>` read as a newline. */
function paragraphLines(page: Page): Promise<string[]> {
  return page
    .locator('.ProseMirror > p')
    .evaluateAll((paragraphs) =>
      paragraphs.map((paragraph) => (paragraph as HTMLElement).innerText.replace(/\n$/, '')),
    );
}

/**
 * Moves the caret `count` characters left, and waits until ProseMirror has
 * read the move: arrow keys move only the DOM caret, which ProseMirror learns
 * from an async `selectionchange`, so a key pressed straight after would be
 * handled against the old caret (see `withCaretObserved`).
 */
async function caretBack(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count - 1; i += 1) await page.keyboard.press('ArrowLeft');
  await withCaretObserved(page, () => page.keyboard.press('ArrowLeft'));
}

/** The visible last line of the last paragraph: what was typed after the last Enter. */
async function lastLine(page: Page): Promise<string | undefined> {
  return (await paragraphLines(page)).at(-1)?.split('\n').at(-1);
}

/** Opens `text` with the caret at the end of the document. */
async function openAtEnd(page: Page, text: string): Promise<void> {
  await open(page, text);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('ControlOrMeta+End');
}

test('one Enter writes one newline, and the next line shows under the first', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n');
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
});

test('two Enters end the paragraph: one blank line', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  expect(await getContent(page)).toBe('one\n\ntwo\n');
  expect(await paragraphLines(page)).toEqual(['one', 'two']);
});

test('three Enters leave an empty paragraph: two blank lines', async ({ page }) => {
  await openAtEnd(page, 'one');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  expect(await getContent(page)).toBe('one\n\n\ntwo\n');
});

test('Shift+Enter is Enter: one newline, then a paragraph break, never a backslash', async ({
  page,
}) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('three');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n\nthree\n');
});

test('Backspace at the start of a line joins it to the line above', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await caretBack(page, 'two'.length);
  await page.keyboard.press('Backspace');
  await settled(page);
  expect(await getContent(page)).toBe('onetwo\n');
});

test('Backspace after two Enters takes back one of them, not both', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await caretBack(page, 'two'.length);
  await page.keyboard.press('Backspace');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n');
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
});

test('Delete at the end of a paragraph joins the next one as a line', async ({ page }) => {
  await open(page, 'one\n\ntwo');
  await caretAtEndOf(page, 'one');
  await page.keyboard.press('Delete');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n');
});

/**
 * Puts the caret `offset` characters into the first text node that holds
 * exactly `text` — a line of a paragraph, which `getByText` cannot address.
 */
async function caretInText(page: Page, text: string, offset: number): Promise<void> {
  await withCaretObserved(page, () =>
    page.evaluate(
      ([wanted, at]) => {
        const root = document.querySelector('.ProseMirror');
        if (!root) throw new Error('no editor');
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent === wanted) {
            getSelection()?.collapse(node, at);
            return;
          }
        }
        throw new Error(`no text node "${wanted}"`);
      },
      [text, offset] as const,
    ),
  );
}

test('Enter at the end of a line with a line below leaves one blank line between them', async ({
  page,
}) => {
  await open(page, 'one\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one\n\ntwo']);
  expect(await getContent(page)).toBe('one\n\ntwo\n');
});

test('two Enters at the end of a line with a line below leave an empty line: two blank lines', async ({
  page,
}) => {
  // The second Enter splits the paragraph, so the line below starts with a
  // line break (the empty line). The save writes it as an empty line, never
  // as a character reference.
  await open(page, 'one\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one', '\ntwo']);
  expect(await getContent(page)).toBe('one\n\n\ntwo\n');
});

test('Backspace under a line that ends in a newline takes back one newline', async ({ page }) => {
  await open(page, 'one\n\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await caretInText(page, 'two', 0);
  await page.keyboard.press('Backspace');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
  expect(await getContent(page)).toBe('one\ntwo\n');
});

test('Delete on an empty last line joins the next paragraph onto it', async ({ page }) => {
  await open(page, 'one\n\ntwo');
  await caretInText(page, 'one', 'one'.length);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one\ntwo']);
  expect(await getContent(page)).toBe('one\ntwo\n');
});

test('bold typed across an Enter stays one bold run', async ({ page }) => {
  await openAtEnd(page, 'start');
  await page.keyboard.type(' ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).toBe('start **one\ntwo**\n');
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror strong').count(), saved).toBe(1);
});

test('a file with single newlines opens on separate lines and is not rewritten', async ({
  page,
}) => {
  await open(page, 'hey man\nyes');
  expect(await paragraphLines(page)).toEqual(['hey man\nyes']);
  expect(await getContent(page)).toBe('hey man\nyes');
});

test('undo after an Enter takes back exactly that newline', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+z');
  await settled(page);
  expect(await paragraphLines(page)).toEqual(['one']);
  expect(await getContent(page)).toBe('one');
});

test('Enter at the end of a heading still starts a paragraph', async ({ page }) => {
  await open(page, '# Title');
  await caretAtEndOf(page, 'Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('body');
  await settled(page);
  expect(await getContent(page)).toBe('# Title\n\nbody\n');
});

test('Enter in a blockquote still splits its paragraph', async ({ page }) => {
  await open(page, '> quote');
  await caretAtEndOf(page, 'quote');
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await getContent(page)).toBe('> quote\n>\n> more\n');
});

test('Enter in a code block is still a newline in the code', async ({ page }) => {
  await open(page, '```\ncode\n```');
  await withCaretObserved(page, () =>
    page.evaluate(() => {
      const text = document.querySelector('.ProseMirror pre code')?.firstChild;
      if (!text) throw new Error('no code text');
      getSelection()?.collapse(text, 'code'.length);
    }),
  );
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await getContent(page)).toBe('```\ncode\nmore\n```\n');
});

test('Shift+Enter in a list item continues the list, as Enter does', async ({ page }) => {
  await open(page, '- a');
  await caretAtEndOf(page, 'a');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('b');
  await settled(page);
  expect(await getContent(page)).toBe('- a\n- b\n');
});

test('Shift+Enter in a table cell is still a line break in that cell, and moves no row', async ({
  page,
}) => {
  await open(page, SMALL_TABLE);
  await caretAtEndOf(page, 'c');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect(await page.locator('.ProseMirror tr').count()).toBe(2);
  expect(await page.locator('.ProseMirror tr').nth(1).locator('td').first().innerText()).toBe(
    'c\nmore',
  );
  const saved = await getContent(page);
  expect(saved.split('\n').filter((line) => line !== '')).toHaveLength(3);
  expect(saved).toContain('| c<br>more | d |');
});

test('"- " typed at the start of a line starts a list from that line', async ({ page }) => {
  await openAtEnd(page, 'Shopping:');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- milk');
  await settled(page);
  expect(await getContent(page)).toBe('Shopping:\n\n- milk\n');
  expect(await page.locator('.ProseMirror > p').first().innerText()).toBe('Shopping:');
  expect(await page.locator('.ProseMirror li').allInnerTexts()).toEqual(['milk']);
});

test('"# " typed at the start of a line makes that line a heading', async ({ page }) => {
  await openAtEnd(page, 'one\ntwo');
  await page.keyboard.press('Enter');
  await page.keyboard.type('# Next');
  await settled(page);
  expect(await getContent(page)).toBe('one\ntwo\n\n# Next\n');
});

test('"|2x2| " typed at the start of a line makes a table from that line', async ({ page }) => {
  await openAtEnd(page, 'one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('|2x2| ');
  await settled(page);
  // The line above stays a paragraph of its own (the empty one after the
  // table is the caret's landing place under a last-block table).
  expect((await paragraphLines(page))[0]).toBe('one');
  expect(await page.locator('.ProseMirror table').count()).toBe(1);
  expect(await getContent(page)).toMatch(/^one\n\n\|/);
});

test('a block format from the toolbar lands on the caret line only', async ({ page }) => {
  await openAtEnd(page, 'one\ntwo\nthree');
  await withCaretObserved(page, () => page.keyboard.press('ArrowUp'));
  await page.evaluate(() =>
    (
      window as unknown as FakeHostWindow & { FutoEditor: { exec(id: string): void } }
    ).FutoEditor.exec('bullet-list'),
  );
  await settled(page);
  expect(await getContent(page)).toBe('one\n\n- two\n\nthree\n');
});
