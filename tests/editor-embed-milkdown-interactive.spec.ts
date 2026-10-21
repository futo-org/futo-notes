import { expect, type Page } from '@playwright/test';
import {
  flushFrames,
  getContent,
  messagesOfType,
  waitForMessages,
  withCaretObserved,
} from './lib/editorEmbedHost';
import {
  test,
  open,
  caretAtEndOf,
  settled,
  caretAtStartOf,
} from './lib/editorEmbedMilkdownInteractive';

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

// Enter at the very start of an item moves the item's text down along with the
// caret, so the NEW item is the empty one left above it: that one is unchecked
// and the done task keeps its check. prosemirror-schema-list applied the new
// item's attrs only to an end-of-item split, so both came out `[x]`.
test('Enter at the start of a checked task item inserts an unchecked item above it', async ({
  page,
}) => {
  await open(page, '- [x] a');
  await caretAtStartOf(page, 'a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('y');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('- [ ]\n- [x] ya');
});

test('Enter in the middle of a checked task item starts the rest unchecked', async ({ page }) => {
  await open(page, '- [x] abcd');
  await caretAtStartOf(page, 'abcd');
  await withCaretObserved(page, () => page.keyboard.press('ArrowRight'));
  await withCaretObserved(page, () => page.keyboard.press('ArrowRight'));
  await page.keyboard.press('Enter');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('- [x] ab\n- [ ] cd');
});

// Delete is a FORWARD delete in a list item and a heading, as in a paragraph.
// The commonmark preset bound its Backspace commands (lift the first item,
// downgrade the heading) to Delete too.
test('Delete at the start of a list item deletes the next character', async ({ page }) => {
  await open(page, '- ab\n- cd');
  await caretAtStartOf(page, 'ab');
  await page.keyboard.press('Delete');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('- b\n- cd');
});

test('Delete at the start of a heading deletes the next character', async ({ page }) => {
  await open(page, '## ab');
  await caretAtStartOf(page, 'ab');
  await page.keyboard.press('Delete');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('## b');
});

/** Click the right edge of the text run `text`, so the caret lands at its end. */
async function caretAtRightEdgeOf(page: Page, text: string): Promise<void> {
  const target = page.getByText(text, { exact: true }).first();
  const box = await target.boundingBox();
  if (!box) throw new Error(`no geometry for ${text}`);
  await withCaretObserved(page, () =>
    target.click({ position: { x: Math.max(box.width - 2, 0), y: box.height / 2 } }),
  );
}

// A fence inside a list item takes Enter as a new line, as a top-level fence
// does (docs/spec/editor/paragraphs-and-lines.md "a code block takes the new
// line inside it"). On the fence's last line the list split ran first.
test('Enter at the end of a fence inside a list item adds a line to the fence', async ({
  page,
}) => {
  await open(page, '- item\n\n  ```js\n  code\n  ```');
  await caretAtRightEdgeOf(page, 'code');
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('- item\n\n  ```js\n  code\n  more\n  ```');
});

test('Enter at the end of a fence inside a checked task item adds a line to the fence', async ({
  page,
}) => {
  await open(page, '- [x] item\n\n  ```js\n  code\n  ```');
  await caretAtRightEdgeOf(page, 'code');
  await page.keyboard.press('Enter');
  await page.keyboard.type('more');
  await settled(page);
  expect((await getContent(page)).trimEnd()).toBe('- [x] item\n\n  ```js\n  code\n  more\n  ```');
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
  // The item now holds two paragraphs, which the house style writes tight, as
  // two lines of one paragraph (docs/spec/editor.md "Lists").
  expect((await getContent(page)).trimEnd()).toBe('- a\n  b');
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
  // Two paragraphs in a row in a tight item are written as two lines of one
  // paragraph, and the item stays tight (docs/spec/editor.md "Lists").
  expect(content).toBe('- a\n  b\n  - c');
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
  expect(content).toBe('- a\n  - x\n    b');
});
