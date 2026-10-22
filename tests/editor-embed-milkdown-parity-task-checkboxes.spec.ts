// Part of the Milkdown parity suite: what it covers and why is described in
// editor-embed-milkdown-parity.spec.ts.

import { expect, type CDPSession, type Page } from '@playwright/test';
import { CHECKBOX_SIZE_PX } from '../src/features/editor/milkdown/taskCheckbox';
import {
  clearMessages,
  flushFrames,
  getContent,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';
import { test, CHANGE_DEBOUNCE_MS, open, tap, centerOf } from './lib/editorEmbedMilkdownParity';

// ============================================================
// Task checkboxes
// ============================================================

test('every task item gets a checkbox and a plain bullet gets none', async ({ page }) => {
  await open(page, '- [ ] todo\n- [x] done\n- plain\n');
  const boxes = page.locator('.ProseMirror .futo-task-checkbox input');
  await expect(boxes).toHaveCount(2);
  expect(await boxes.nth(0).isChecked()).toBe(false);
  expect(await boxes.nth(1).isChecked()).toBe(true);
});

test('a nested task item keeps its checkbox when the parent is edited', async ({ page }) => {
  await open(page, '- [ ] parent\n  - [ ] child\n');
  await expect(page.locator('.ProseMirror .futo-task-checkbox input')).toHaveCount(2);

  await page.locator('.ProseMirror li p').first().click();
  await page.keyboard.type('!');
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  await expect(page.locator('.ProseMirror .futo-task-checkbox input')).toHaveCount(2);
  expect(await getContent(page)).toContain('[ ] child');
});

test('toggling a nested task item writes only its own checkbox', async ({ page }) => {
  await open(page, '- [ ] parent\n  - [ ] child\n');
  const { x, y } = await centerOf(page, '.futo-task-checkbox', 1);
  await page.mouse.click(x, y);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  const saved = await getContent(page);
  expect(saved).toContain('[ ] parent');
  expect(saved).toContain('[x] child');
});

test('an uppercase `[X]` renders checked', async ({ page }) => {
  await open(page, '- [X] shouty\n');
  expect(await page.locator('.ProseMirror .futo-task-checkbox input').isChecked()).toBe(true);
});

test('clicking a checkbox writes `[x]` and reports the change', async ({ page }) => {
  await open(page, '- [ ] todo\n');
  await clearMessages(page);

  const { x, y } = await centerOf(page, '.futo-task-checkbox');
  await page.mouse.click(x, y);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  expect(await getContent(page)).toContain('[x] todo');
  expect((await messagesOfType(page, 'change')).length).toBeGreaterThan(0);
});

test('clicking a checked checkbox writes `[ ]` back', async ({ page }) => {
  await open(page, '- [x] done\n');
  const { x, y } = await centerOf(page, '.futo-task-checkbox');
  await page.mouse.click(x, y);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  expect(await getContent(page)).toContain('[ ] done');
});

test('clicking one checkbox leaves the others alone', async ({ page }) => {
  await open(page, '- [ ] one\n- [ ] two\n- [ ] three\n');
  const { x, y } = await centerOf(page, '.futo-task-checkbox', 1);
  await page.mouse.click(x, y);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  const saved = await getContent(page);
  expect(saved).toContain('[ ] one');
  expect(saved).toContain('[x] two');
  expect(saved).toContain('[ ] three');
});

/*
 * The phone story. A real finger, and the assertion that separates a working
 * checkbox from an annoying one: the tap must not focus the editable, because
 * focusing it is what raises the keyboard over the list the user is ticking
 * through ("no cursor placement needed", docs/spec/editor.md).
 */
test('tapping a checkbox toggles it without focusing the editor', async ({ page }) => {
  await open(page, '- [ ] todo\n');
  const { x, y } = await centerOf(page, '.futo-task-checkbox');

  await tap(page, x, y);

  expect(await getContent(page)).toContain('[x] todo');
  expect(await page.evaluate(() => document.activeElement?.className ?? '')).not.toContain(
    'ProseMirror',
  );
});

test('the tap target is at least as big as a fingertip needs', async ({ page }) => {
  await open(page, '- [ ] todo\n');
  const { box } = await centerOf(page, '.futo-task-checkbox');
  expect(box.width).toBeGreaterThanOrEqual(CHECKBOX_SIZE_PX);
  expect(box.height).toBeGreaterThanOrEqual(CHECKBOX_SIZE_PX);
});

test('a bullet task item is indented like a bullet, not one level deeper', async ({ page }) => {
  // The checkbox takes the hidden bullet's marker column; it is not a second
  // slot beside it. So task text starts where bullet text does (the list's
  // padding is the 28px tap target plus 2px of screen-edge clearance, against
  // 1.4em for a bullet — that is the whole tolerance), and the checkbox sits
  // inside the list's own box.
  await open(page, '- bullet\n\nbetween\n\n- [ ] todo\n');
  const left = (selector: string) =>
    page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().left, selector);
  const bulletText = await left('.ProseMirror ul:not(:has(> li[data-checked])) > li > p');
  const taskText = await left('.ProseMirror li[data-checked] > p');
  const taskList = await left('.ProseMirror ul:has(> li[data-checked])');
  const { box } = await centerOf(page, '.futo-task-checkbox');
  expect(Math.abs(taskText - bulletText)).toBeLessThanOrEqual(8);
  expect(box.x).toBeGreaterThanOrEqual(taskList - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(taskText + 0.5);
});

test('the checkbox stays clear of the screen edge iOS reserves', async ({ page }) => {
  // UIKit's interactive-pop gesture owns the leftmost 20pt of the screen and
  // swallows touches that start there — a checkbox reaching into it would be
  // untappable on a real iPhone (see MilkdownEditor.svelte's gutter comment).
  await open(page, '- [ ] todo\n');
  const { box } = await centerOf(page, '.futo-task-checkbox');
  expect(box.x).toBeGreaterThanOrEqual(20);
});

/* An empty task item is checkbox widget + ProseMirror's separator <img> +
 * trailing <br>. The global `img { display: block }` reset made the separator a
 * block, which split the line and drew the caret ABOVE it — "cursor is too high
 * when no text is entered". Headless engines do not paint a caret, so this
 * holds the thing the caret is drawn against: the separator sits on the line,
 * not at its top edge. */
test('the caret in an empty task item sits on the line, not above it', async ({ page }) => {
  await open(page, '- [ ] tasks\n');
  // Enter at the end of a task item makes the empty one, as a user would.
  // Control+End would land in the trailing paragraph after the list instead.
  const { x, y } = await centerOf(page, '.ProseMirror li p');
  await page.mouse.click(x, y);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.locator('.ProseMirror li')).toHaveCount(2);
  await flushFrames(page);
  const geometry = await page.evaluate(() => {
    const item = document.querySelectorAll('.ProseMirror li')[1];
    const separator = item.querySelector('img.ProseMirror-separator');
    const line = item.getBoundingClientRect();
    return {
      display: separator ? getComputedStyle(separator).display : null,
      offset: separator ? separator.getBoundingClientRect().top - line.top : null,
      height: line.height,
    };
  });
  expect(geometry.display).toBe('inline');
  expect(geometry.offset).toBeGreaterThan(geometry.height * 0.3);
});

/*
 * A phone keyboard moves the caret by offsets into the editable's text: a
 * space-bar swipe, and the caret it leaves after deleting. Chromium's IME path
 * counted a light-DOM checkbox `<input>` as one character, so the offset at a
 * task's text start resolved beside the input, inside the uneditable widget.
 * Blink dropped the selection there, and on Android the editor lost focus and
 * the keyboard closed (#69 swipe, #71 backspace). Desktop Chromium takes the same
 * offset path through CDP and shows the dropped selection.
 */
type Caret = { live: boolean; text: string | null; offset: number; item: number };

function caret(page: Page): Promise<Caret> {
  return page.evaluate(() => {
    const selection = getSelection()!;
    const anchor = selection.anchorNode;
    const items = [...document.querySelectorAll('.ProseMirror li')];
    return {
      live: selection.rangeCount === 1 && !!document.activeElement?.contains(anchor),
      text: anchor?.nodeType === Node.TEXT_NODE ? anchor.textContent : null,
      offset: selection.anchorOffset,
      item: items.findIndex((li) => li.contains(anchor)),
    };
  });
}

/** The IME replacing text offsets `from`..`to` with nothing; an empty range moves the caret. */
async function imeReplace(page: Page, cdp: CDPSession, from: number, to = from): Promise<void> {
  await cdp.send('Input.imeSetComposition', {
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
    replacementStart: from,
    replacementEnd: to,
  });
  await flushFrames(page);
}

/**
 * The IME offset of `offset` characters into the text run `text`, found by
 * trying each from a caret parked in the note's first line, so a try that
 * does not move the caret cannot pass for one that did.
 */
async function imeOffsetOf(page: Page, cdp: CDPSession, text: string, offset: number) {
  // A real click first: CDP's IME calls wait on a page that has input focus.
  await page.getByText(text, { exact: true }).click();
  for (let at = 0; at < 40; at++) {
    await page.evaluate(() => {
      (window as unknown as FakeHostWindow).FutoEditor.focus();
      const first = document.querySelector('.ProseMirror p')!.firstChild!;
      getSelection()!.collapse(first, 0);
    });
    await flushFrames(page);
    await imeReplace(page, cdp, at);
    const now = await caret(page);
    if (now.text === text && now.offset === offset) return at;
  }
  throw new Error(`no IME offset puts the caret at ${text}:${offset}`);
}

test('an IME caret walk crosses a task text start and keeps the caret', async ({ page }) => {
  await open(page, 'Shopping\n\n- [ ] milk\n- [ ] eggs\n');
  const cdp = await page.context().newCDPSession(page);
  const end = await imeOffsetOf(page, cdp, 'eggs', 4);

  const walk: Caret[] = [];
  for (let step = 1; step <= 5; step++) {
    await imeReplace(page, cdp, end - step);
    walk.push(await caret(page));
  }

  expect(walk.map(({ live, text, offset }) => [live, text, offset])).toEqual([
    [true, 'eggs', 3],
    [true, 'eggs', 2],
    [true, 'eggs', 1],
    [true, 'eggs', 0],
    [true, 'milk', 4],
  ]);
});

test('an IME backspace that empties a task keeps the caret in it', async ({ page }) => {
  await open(page, 'Shopping\n\n- [ ] milk\n- [ ] e\n');
  const cdp = await page.context().newCDPSession(page);
  const afterE = await imeOffsetOf(page, cdp, 'e', 1);

  await imeReplace(page, cdp, afterE - 1, afterE);
  await cdp.send('Input.insertText', { text: '' });
  await flushFrames(page);

  expect(await getContent(page)).toBe('Shopping\n\n- [ ] milk\n- [ ]\n');
  expect(await caret(page)).toMatchObject({ live: true, item: 1 });
});

test('clicking the item text places the caret instead of toggling', async ({ page }) => {
  await open(page, '- [ ] todo\n');
  const { x, y } = await centerOf(page, '.ProseMirror li p');
  await page.mouse.click(x, y);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  expect(await getContent(page)).toContain('[ ] todo');
});

test('a toggle is one undo step, and undo puts the tick back', async ({ page }) => {
  await open(page, '- [ ] todo\n');
  const { x, y } = await centerOf(page, '.futo-task-checkbox');
  await page.mouse.click(x, y);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  expect(await getContent(page)).toContain('[x] todo');

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  expect(await getContent(page)).toContain('[ ] todo');
});
