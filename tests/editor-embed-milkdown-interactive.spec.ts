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
