// Part of the Milkdown parity suite: what it covers and why is described in
// editor-embed-milkdown-parity.spec.ts.

import { expect } from '@playwright/test';
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
