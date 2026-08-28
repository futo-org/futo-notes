import { expect, test as base, type CDPSession, type Page } from '@playwright/test';

import { extractHeaderTagBlock, extractTags } from '../packages/editor/src/tags';
import { CHECKBOX_SIZE_PX } from '../src/features/editor/milkdown/taskCheckbox';
import { EDITOR_URL } from './editorEmbedBundle';
import {
  clearMessages,
  flushFrames,
  getContent,
  installFakeAndroidHost,
  messagesOfType,
  type FakeHostWindow,
} from './lib/editorEmbedHost';

/**
 * Editing-surface parity, Milkdown engine — tags, task checkboxes, and fenced
 * code highlighting, driven against the single-file `editor.html` the native
 * shells actually ship (issue #102, docs/plan/milkdown-transition.md §4
 * bucket 1).
 *
 * The bridge contract and the load-echo/undo data-safety invariants live in
 * `editor-embed-milkdown.spec.ts`; this file is the three editing surfaces and
 * nothing else.
 *
 * Real input only, and both kinds of it: Playwright mouse for the desktop
 * story and CDP `Input.dispatchTouchEvent` for the phone story. A DOM
 * `dispatchEvent` would sail past the very listeners under test (AGENTS.md
 * M21), and mouse-only coverage would have missed the thing that actually
 * matters on a phone — that tapping a checkbox does not raise the keyboard.
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

async function open(page: Page, content: string, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.evaluate(
    (json) => (window as unknown as FakeHostWindow).FutoEditor.initialize(json),
    JSON.stringify({
      bridgeVersion: 7,
      theme,
      content,
      nativeToolbar: true,
      contentPaddingInlinePx: 14,
    }),
  );
  await flushFrames(page);
}

/** Type one character at the very end, the smallest thing that is a real edit. */
async function typeAtEnd(page: Page, text = 'X'): Promise<void> {
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
}

async function tap(page: Page, x: number, y: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(x), y: Math.round(y), id: 1 }],
  });
  await page.waitForTimeout(40);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);
  return cdp;
}

async function centerOf(page: Page, selector: string, nth = 0) {
  const box = await page.locator(selector).nth(nth).boundingBox();
  if (!box) throw new Error(`no geometry for ${selector} #${nth}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

// ============================================================
// Tags
// ============================================================

/*
 * The one that is data safety, not decoration. remark-stringify escapes any
 * line-leading `#`, so before packages/editor/src/milkdown-compat/atxEscape.ts
 * the first edit to a note turned its header tag block `#alpha #beta` into
 * `\#alpha #beta` — and `\#alpha` is a tag to nothing: not to this app's rule,
 * not to the desktop tag bar, not to Obsidian. The tag was gone from the note.
 */
test('editing a note never escapes its tags away', async ({ page }) => {
  await open(page, '#alpha #beta\n\nBody text\n');

  await typeAtEnd(page);

  const saved = await getContent(page);
  expect(saved).toContain('#alpha #beta');
  expect(saved).not.toContain('\\#');
});

test('the tag rules still read every tag out of what Milkdown saved', async ({ page }) => {
  const original = '#alpha #beta\n\nBody with #inline and a #trailing.\n';
  await open(page, original);

  await typeAtEnd(page);
  const saved = await getContent(page);

  // The desktop tag bar is built from exactly these two rules, so this is what
  // "the tag bar behaves per spec" reduces to once the editor has re-saved.
  expect(extractTags(saved)).toEqual(extractTags(original));
  expect(extractHeaderTagBlock(saved).tags).toEqual(extractHeaderTagBlock(original).tags);
});

test('a line-leading `#` that IS a heading still round-trips as a heading', async ({ page }) => {
  await open(page, '# A real heading\n\nbody\n');
  await typeAtEnd(page);
  expect(await getContent(page)).toContain('# A real heading');
  expect(await page.locator('.ProseMirror h1')).toHaveText('A real heading');
});

test('an inline tag is decorated', async ({ page }) => {
  await open(page, 'Some #project work here\n');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveText('#project');
});

test('a tag inside inline code or a fence is not decorated', async ({ page }) => {
  await open(page, 'Text `#nope` here\n\n```\n#alsonope\n```\n\nand #yes\n');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveCount(1);
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveText('#yes');
});

test('a `#` that is not a tag is left plain', async ({ page }) => {
  await open(page, 'C# and issue #5 and a#b\n');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveCount(0);
});

test('a tag is decorated as soon as it is typed', async ({ page }) => {
  await open(page, 'note:\n');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' #later');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveText('#later');
});

test('a `#` typed straight onto a word is not a tag', async ({ page }) => {
  // The boundary half of the same rule: `note:#later` has no whitespace before
  // the `#`, so it is not a tag and must not be coloured like one.
  await open(page, 'note:\n');
  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type('#later');
  await expect(page.locator('.ProseMirror .futo-tag')).toHaveCount(0);
});

/*
 * The CodeMirror editor hides a leading header tag block while the caret is
 * away; this editor deliberately does not — a ProseMirror node rendered
 * `display: none` cannot be reached by caret or click, so hiding it would make
 * the note's tags uneditable, and on the native shells (no tag bar) invisible
 * as well. Recorded as a gap in docs/spec/editor.md. This test is the lock on
 * the CURRENT behavior: the block is visible and its tags are decorated.
 */
test('a leading header tag block stays visible, with its tags decorated', async ({ page }) => {
  await open(page, '#alpha #beta\n\nBody text\n');
  const first = page.locator('.ProseMirror > p').first();
  await expect(first).toBeVisible();
  await expect(first.locator('.futo-tag')).toHaveCount(2);
});

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

test('the checkbox stays clear of the screen edge iOS reserves', async ({ page }) => {
  // UIKit's interactive-pop gesture owns the leftmost 20pt of the screen and
  // swallows touches that start there — a checkbox reaching into it would be
  // untappable on a real iPhone (see MilkdownEditor.svelte's gutter comment).
  await open(page, '- [ ] todo\n');
  const { box } = await centerOf(page, '.futo-task-checkbox');
  expect(box.x).toBeGreaterThanOrEqual(20);
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
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  expect(await getContent(page)).toContain('[ ] todo');
});

// ============================================================
// Fenced code highlighting
// ============================================================

/** Waits for the fence's grammar to arrive — it is fetched on first use. */
async function waitForTokens(page: Page): Promise<void> {
  await page.locator('.ProseMirror pre .tok-keyword').first().waitFor({ timeout: 10_000 });
}

test('a fence in a curated language is coloured', async ({ page }) => {
  await open(page, '```js\nconst greeting = "hi";\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveText('const');
  await expect(page.locator('.ProseMirror pre .tok-string')).toHaveText('"hi"');
});

test('a language alias is matched, not just the canonical name', async ({ page }) => {
  await open(page, '```rs\nfn main() {}\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveText('fn');
});

test('a fence outside the curated set still renders, just uncoloured', async ({ page }) => {
  await open(page, '```mermaid\ngraph TD\n```\n');
  await flushFrames(page);
  await expect(page.locator('.ProseMirror pre')).toHaveText('graph TD');
  await expect(page.locator('.ProseMirror pre span')).toHaveCount(0);
});

test('a fence with no language still renders, just uncoloured', async ({ page }) => {
  await open(page, '```\nplain text\n```\n');
  await flushFrames(page);
  await expect(page.locator('.ProseMirror pre')).toHaveText('plain text');
  await expect(page.locator('.ProseMirror pre span')).toHaveCount(0);
});

test('every fence carries the class the shared token palette keys off', async ({ page }) => {
  await open(page, '```js\nlet a = 1;\n```\n\n```mermaid\ngraph TD\n```\n');
  await expect(page.locator('.ProseMirror pre.futo-code-tokens')).toHaveCount(2);
});

test('token colours come from the theme, and follow it', async ({ page }) => {
  await open(page, '```js\nconst a = 1;\n```\n');
  await waitForTokens(page);
  const light = await page
    .locator('.ProseMirror pre .tok-keyword')
    .evaluate((el) => getComputedStyle(el).color);

  await page.evaluate(() => (window as unknown as FakeHostWindow).FutoEditor.setTheme('dark'));
  await flushFrames(page);
  const dark = await page
    .locator('.ProseMirror pre .tok-keyword')
    .evaluate((el) => getComputedStyle(el).color);

  expect(light).not.toBe('rgba(0, 0, 0, 0)');
  expect(dark).not.toBe(light);
});

test('editing inside a fence re-colours it', async ({ page }) => {
  await open(page, '```js\nconst a = 1;\n```\n');
  await waitForTokens(page);

  await page.locator('.ProseMirror pre').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nlet b = 2;');
  await page.waitForTimeout(CHANGE_DEBOUNCE_MS + 120);

  await expect(page.locator('.ProseMirror pre .tok-keyword')).toHaveCount(2);
  expect(await getContent(page)).toContain('let b = 2;');
});

test('a fence typed into a note gets coloured once its grammar arrives', async ({ page }) => {
  await open(page, '```python\ndef f():\n    return 1\n```\n');
  await waitForTokens(page);
  await expect(page.locator('.ProseMirror pre .tok-keyword').first()).toHaveText('def');
});

test('tags and checkboxes and fences all survive one round trip together', async ({ page }) => {
  const note =
    '#alpha\n\n- [ ] todo\n- [x] done\n\n```js\nconst a = 1;\n```\n\nBody #inline here\n';
  await open(page, note);
  await typeAtEnd(page);

  const saved = await getContent(page);
  expect(extractTags(saved)).toEqual(extractTags(note));
  expect(saved).toContain('[ ] todo');
  expect(saved).toContain('[x] done');
  expect(saved).toContain('```js\nconst a = 1;\n```');
});
