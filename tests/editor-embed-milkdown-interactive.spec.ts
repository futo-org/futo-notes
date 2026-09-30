import { expect, test as base, type Page } from '@playwright/test';

import { BRIDGE_VERSION } from '@futo-notes/editor';

import { EDITOR_URL } from './editorEmbedBundle';
import {
  flushFrames,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
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
 * Click at the START of the first text run equal to `text` (see
 * `caretAtEndOf`). `Home` moves the caret through the browser's own native
 * contenteditable handling too, so it needs the same `selectionchange` wait
 * the click does — without it, the Backspace that follows sees the
 * PRE-`Home` caret and misreads the item as one whose text is not at offset 0.
 */
async function caretAtStartOf(page: Page, text: string): Promise<void> {
  await withCaretObserved(page, () => page.getByText(text, { exact: true }).first().click());
  await withCaretObserved(page, () => page.keyboard.press('Home'));
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
  expect(content).toBe('- a\n\n  b\n  - c');
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
  // block's single text node ("one\ntwo\nthree") never does — a plain,
  // non-exact match is unambiguous here instead.
  await withCaretObserved(page, () => page.getByText('one').first().click());
  await withCaretObserved(page, () => page.keyboard.press('Home'));
  await withCaretObserved(page, () => page.keyboard.press('Shift+ArrowDown')); // start of "two"
  await withCaretObserved(page, () => page.keyboard.press('Shift+End')); // end of "two"
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
  await withCaretObserved(page, () => page.keyboard.press('Home'));
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
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setContent('-'));
  await page.evaluate(
    (m) => (window as unknown as FakeHostWindow).FutoEditor.setContent(m),
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

test('a line typed after Shift+Enter that starts with "# " stays in the paragraph', async ({
  page,
}) => {
  await open(page, 'Notes');
  await caretAtEndOf(page, 'Notes');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('# not a heading ');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type('bold');
  await settled(page);
  const saved = await getContent(page);
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror h1').count(), saved).toBe(0);
  expect(await page.locator('.ProseMirror p').first().textContent(), saved).toBe(
    'Notes# not a heading bold',
  );
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

test('Shift+Enter in an H4 never adds a backslash to the heading', async ({ page }) => {
  // An ATX heading is one line. The break handler wrote `\` + newline there,
  // which ended the heading: it reopened as `Plan\` plus a paragraph.
  await open(page, '#### Plan');
  await caretAtEndOf(page, 'Plan');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('next');
  await settled(page);
  const saved = await getContent(page);
  expect(saved).not.toContain('\\');
  await reopen(page, saved);
  expect(await page.locator('.ProseMirror h4').allTextContents(), saved).toEqual(['Plan next']);
  expect(await page.locator('.ProseMirror p').count(), saved).toBe(0);
});

test('Shift+Enter directly before inline HTML keeps the break and adds no backslash', async ({
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
  await page.keyboard.press('Shift+Enter');
  await settled(page);
  const saved = await getContent(page);
  // `\` + space is a literal backslash on one line; `<br>` is the break.
  expect(saved).toBe('Press <br><kbd>Ctrl</kbd> now\n');
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
  expect(await page.locator('.ProseMirror p em').allTextContents(), saved).toEqual(['b', 'c']);
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
    expect(saved).toBe(`Notes\n\n${typed}\n`);
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
  expect(await getContent(page)).toBe('Notes\n\nsee ![alt](https://example.com/a.png) here\n');
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
  expect(await page.locator('.ProseMirror p').last().textContent()).toBe(
    '![alt](https://example.com/a.png',
  );

  // Control: the strong rule, same shape.
  await page.keyboard.press('Enter');
  await page.keyboard.type('**bold*');
  await page.waitForTimeout(700);
  await page.keyboard.type('*');
  await expect(page.locator('.ProseMirror p strong')).toHaveText('bold');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.ProseMirror p strong')).toHaveCount(0);
  expect(await page.locator('.ProseMirror p').last().textContent()).toBe('**bold*');
});

test('a typed image does not convert inside inline code', async ({ page }) => {
  await typeAfterNotes(page, '`![alt](https://example.com/a.png)`');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  await expect(page.locator('.ProseMirror p code').last()).toHaveText(
    '![alt](https://example.com/a.png)',
  );
  expect(await getContent(page)).toBe('Notes\n\n`![alt](https://example.com/a.png)`\n');
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
  expect(await page.locator('.ProseMirror p').last().textContent(), saved).toBe(
    '\\![alt](https://example.com/a.png)',
  );
});

test('a typed plain link `[a](b)` is not turned into an image or a link', async ({ page }) => {
  await typeAfterNotes(page, '[a](https://example.com)');
  await expect(page.locator(IMAGES)).toHaveCount(0);
  expect(await page.locator('.ProseMirror p').last().textContent()).toBe(
    '[a](https://example.com)',
  );
});
